'use strict';

module.exports = Session;


var amf = require('amflib/node-amf/amf');
var domain = require('domain');
var events = require('events');
var util = require('util');
var config = require('config');
var RC = require('data/RequestContext');


util.inherits(Session, events.EventEmitter);


/**
 * A `Session` object corresponds to the connection between one game
 * client and the game server it is connected to. A new session is
 * initialized for each new connection to the GS; after successful
 * login, the respective {@link Player} object is associated with the
 * session (and vice-versa), linking the model and communications
 * layers.
 *
 * Incoming data is deserialized here, and each resulting message is
 * passed on to the GSJS request handler for processing within a new
 * request context. Any unhandled errors there are processed by the
 * {@link Session#handleAmfReqError|handleAmfReqError} function; lower
 * level problems (e.g. during AMF deserialization) are handled by the
 * {@link http://nodejs.org/docs/latest/api/domain.html|domain} based
 * {@link Session#handleError|handleError} function, as well as
 * networking errors.
 *
 * Since sessions are usually short-lived (client commonly has to
 * reconnect to other GS when the player is changing locations) and
 * the client already contains functionality to reconnect after an
 * intermittent connection loss, they are not persisted across server
 * restarts.
 *
 * `Session` is a Node.js `{@link http://nodejs.org/api/events.html#events_class_events_eventemitter
 * EventEmitter}`, emitting the following events:
 * * `close` when the client connection has been closed (cleanly or
 *   after an error)
 *
 * @param {string} id unique ID for this session (unique per GS)
 * @param {Socket} socket TCP socket connection to the client
 *
 * @constructor
 */
function Session(id, socket) {
	Session.super_.call(this);
	this.id = id;
	this.socket = socket;
	this.ts = new Date().getTime();
	this.maxMsgSize = config.get('net:maxMsgSize');
	// disable Nagle's algorithm (we need all messages delivered as quickly as possible)
	this.socket.setNoDelay(true);
	// set up domain for low-level issue handling (networking and
	// AMF deserialization issues)
	this.dom = domain.create();
	this.dom.add(this.socket);
	this.dom.on('error', this.handleError.bind(this));
	this.setupSocketEventHandlers();
	log.info({session: this}, 'new session created');
}


Session.prototype.setupSocketEventHandlers = function() {
	this.socket.on('data', this.onSocketData.bind(this));
	this.socket.on('end', this.onSocketEnd.bind(this));
	this.socket.on('timeout', this.onSocketTimeout.bind(this));
	this.socket.on('close', this.onSocketClose.bind(this));
	// 'error' handled by domain error handler anyway
};


Session.prototype.toString = function() {
	return util.format('[session#%s%s]', this.id, this.pc ? '|' + this.pc.tsid : '');
};


/**
 * Class method for serializing the session field for the
 * session-specific child logger.
 * @see {@link https://github.com/trentm/node-bunyan#logchild}
 * @static
 * @private
 */
Session.logSerialize = function(session) {
	var ret = {id: session.id};
	if (session.socket && session.socket.remoteAddress) {
		ret.addr = session.socket.remoteAddress + ':' + session.socket.remotePort;
	}
	if (session.pc) {
		ret.pc = session.pc.tsid;
	}
	return ret;
};


Session.prototype.onSocketData = function(data) {
	// wrap in nextTick to make sure sync errors are handled, too;
	// see <https://stackoverflow.com/q/19461234/>
	process.nextTick(this.handleData.bind(this, data));
};


Session.prototype.onSocketEnd = function() {
	log.info({session: this}, 'socket end');
};


Session.prototype.onSocketTimeout = function() {
	log.warn({session: this}, 'socket timeout');
};


Session.prototype.onSocketClose = function(hadError) {
	log.info({session: this}, 'socket close (hadError: %s)', hadError);
	this.emit('close', this);
};


/**
 * Handles low-level networking errors, as well as any errors from
 * higher layers (e.g. game logic) that were not caught by the request
 * context error handler
 * (see {@link Session#handleAmfReqError|handleAmfReqError}).
 * Currently simply terminates the connection to the client.
 *
 * TODO: more elaborate error handling.
 *
 * @param {Error} error the error to handle
 * @private
 */
Session.prototype.handleError = function(err) {
	log.error({session: this, err: err},
		'unhandled error: %s', err ? err.message : err);
	// careful cleanup - if anything throws here, the server goes down
	if (this.socket && typeof this.socket.destroy === 'function') {
		log.info({session: this}, 'destroying socket');
		this.socket.destroy();
	}
};


/**
 * Consumer of incoming socket data. Called whenever the socket's
 * `data` event is emitted (i.e. the supplied data chunk is not
 * necessarily a single, complete request).
 *
 * @param {Buffer} incoming data chunk
 * @private
 */
Session.prototype.handleData = function(data) {
	if (!this.buffer) {
		this.buffer = data;
	}
	else {
		var len = this.buffer.length + data.length;
		this.buffer = Buffer.concat([this.buffer, data], len);
	}
	setImmediate(this.checkForMessages.bind(this));
};


Session.prototype.checkForMessages = function() {
	// if node scheduled multiple consecutive calls, the first one has already
	// processed all available messages, so, hammertime
	if (!this.buffer) return;
	// buffer can contain multiple messages (and the last one may be incomplete);
	// since we don't have message length data, all we can do is try parsing
	// messages repeatedly until all data is consumed, or deserialization fails
	var index = 0;  // AMF deserializer index
	var bufstr = this.buffer.toString('binary');
	var deser = amf.deserializer(bufstr);
	while (index < bufstr.length) {
		var msg;
		try {
			msg = deser.readValue(amf.AMF3);
		}
		catch (e) {
			// incomplete message; abort and preserve remaining (unparsed) data
			// for next round
			log.debug('%s bytes remaining', bufstr.length - index);
			this.buffer = new Buffer(bufstr.substr(index), 'binary');
			break;
		}
		// still here? then update index and schedule message handling
		index = deser.i;
		setImmediate(this.handleMessage.bind(this), msg);
	}
	if (index >= bufstr.length) {
		delete this.buffer;  // buffer fully processed
	}
	// protection against broken/malicious clients
	if (this.buffer && this.buffer.length > this.maxMsgSize) {
		throw new Error('could not process incoming message(s) ' +
			'(buffer length: ' + this.buffer.length + ' bytes)');
	}
};


Session.prototype.handleMessage = function(msg) {
	log.trace({data: msg}, 'got %s request', msg.type);
	var self = this;
	var rc = new RC(msg.type, this.pc, this);
	rc.run(
		function clientReq() {
			self.processRequest.call(self, msg);
		},
		function callback(err) {
			if (err) self.handleAmfReqError.call(self, err, msg);
		}
	);
};


Session.prototype.processRequest = function(req) {
	//TODO: actual request processing.
	log.info({data: req}, 'I would handle a %s request now if I knew how', req.type);
};


Session.prototype.handleAmfReqError = function(err, req) {
	if (typeof err === 'object' && err.type === 'stack_overflow') {
		// special treatment for stack overflow errors
		// see <https://github.com/trentm/node-bunyan/issues/127>
		err = new Error(err.message);
	}
	log.error(err, 'error processing %s request for %s', req.type, this.pc);
	if (this.pc && req.id) {
		// send error response back to client
		var rsp = {
			msg_id: req.id,
			type: req.type,
			success: false,
			msg: err.message,
		};
		log.info({data: rsp}, 'sending error response');
		try {
			this.send(rsp);
		}
		catch (e) {
			log.error(e, 'could not send error response to client');
		}
	}
	// TODO: more appropriate error handling (disconnect? roll back modified
	// objects (invalidate/reload dirty objects in persistence layer)?)
};


/**
 * Sends an AMF3 encoded message to the connected client (prefixed by
 * the message length, as the client expects).
 *
 * @param {object} msg the message to send; must not contain anything
 *        that cannot be encoded in AMF3 (e.g. circular references)
 */
Session.prototype.send = function(msg) {
	log.trace({data: msg}, 'sending %s message', msg.type);
	var data = amf.serializer().writeObject(msg);
	var size = Buffer.byteLength(data, 'binary');
	var buf = new Buffer(4 + size);
	buf.writeUInt32BE(size, 0);
	buf.write(data, 4, size, 'binary');
	this.socket.write(buf);
};
