"use strict";


const EventEmitter = require("events");
const dgram = require("dgram");
const net = require('net')
const KNXConstants = require("./protocol/KNXConstants");
const CEMIConstants = require("./protocol/cEMI/CEMIConstants");
const CEMIFactory = require("./protocol/cEMI/CEMIFactory");
const KNXProtocol = require("./protocol/KNXProtocol");
const KNXConnectResponse = require("./protocol/KNXConnectResponse");
const HPAI = require("./protocol/HPAI");
const TunnelCRI = require("./protocol/TunnelCRI");
const KNXConnectionStateResponse = require("./protocol/KNXConnectionStateResponse");
const errors = require("./errors");
const ipAddressHelper = require("./util/ipAddressHelper");
const KNXAddress = require("./protocol/KNXAddress").KNXAddress;
const KNXDataBuffer = require("./protocol/KNXDataBuffer").KNXDataBuffer;
const DPTLib = require('./dptlib');
const secureKeyring = require("./KNXsecureKeyring.js");
//const lodash = require("lodash");

var STATE;
(function (STATE) {
    STATE[STATE["STARTED"] = 0] = "STARTED";
    STATE[STATE["CONNECTING"] = 3] = "CONNECTING";
    STATE[STATE["CONNECTED"] = 4] = "CONNECTED";
    STATE[STATE["DISCONNECTING"] = 5] = "DISCONNECTING";
    STATE[STATE["DISCONNECTED"] = 6] = "DISCONNECTED";
})(STATE || (STATE = {}));
var TUNNELSTATE;
(function (TUNNELSTATE) {
    TUNNELSTATE[TUNNELSTATE["READY"] = 0] = "READY";
})(TUNNELSTATE || (TUNNELSTATE = {}));
const SocketEvents = {
    error: 'error',
    message: 'message',
    listening: "listening",
    data: "data",
    close: "close"
};
var KNXClientEvents;
(function (KNXClientEvents) {
    KNXClientEvents["error"] = "error";
    KNXClientEvents["disconnected"] = "disconnected";
    KNXClientEvents["discover"] = "discover";
    KNXClientEvents["indication"] = "indication";
    KNXClientEvents["connected"] = "connected";
    KNXClientEvents["ready"] = "ready";
    KNXClientEvents["response"] = "response";
    KNXClientEvents["connecting"] = "connecting";
})(KNXClientEvents || (KNXClientEvents = {}));

// const KNXClientEvents = {
//     error: "error",
//     disconnected: "disconnected",
//     discover: "discover",
//     indication: "indication",
//     connected: "connected",
//     ready: "ready",
//     response: "response",
//     connecting: "connecting"
// };

// options:
const optionsDefaults = {
    physAddr: '15.15.200',
    connectionKeepAliveTimeout: KNXConstants.KNX_CONSTANTS.CONNECTION_ALIVE_TIME,
    ipAddr: "224.0.23.12",
    ipPort: 3671,
    hostProtocol: "TunnelUDP", // TunnelUDP, TunnelTCP, Multicast
    isSecureKNXEnabled: false,
    suppress_ack_ldatareq: false,
    loglevel: "info",
    localEchoInTunneling: true,
    localIPAddress: "",
    interface: ""
};

class KNXClient extends EventEmitter {

    constructor(options) {

        if (options === undefined) {
            options = optionsDefaults;
        }

        super();
        this._clientTunnelSeqNumber = 0;
        this._options = options;//Object.assign(optionsDefaults, options);
        this._options.connectionKeepAliveTimeout = KNXConstants.KNX_CONSTANTS.CONNECTION_ALIVE_TIME,
            this._localPort = null;
        this._peerHost = this._options.ipAddr;
        this._peerPort = this._options.ipPort;
        this._timer = null;
        this._heartbeatFailures = 0;
        this.max_HeartbeatFailures = 3;
        this._heartbeatTimer = null;
        this._discovery_timer = null;
        this._awaitingResponseType = null;
        this._processInboundMessage = this._processInboundMessage.bind(this);
        this._clientSocket = null;
        this.sysLogger = null;
        try {
            this.sysLogger = require("./KnxLog.js").get({ loglevel: this._options.loglevel }); // 08/04/2021 new logger to adhere to the loglevel selected in the config-window            
        } catch (error) {
            console.log("BANANA ERRORE this.sysLogger = require", error.message);
            throw (error);
        }

        if (typeof this._options.physAddr === "string") this._options.physAddr = KNXAddress.createFromString(this._options.physAddr);
        try {
            this._options.localIPAddress = ipAddressHelper.getLocalAddress(this._options.interface); // Get the local address of the selected interface    
        } catch (error) {
            if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.error("ipAddressHelper.getLocalAddress:" + error.message);
            throw (error);
        }

        let conn = this;
        // 07/12/2021 Based on protocol instantiate the right socket
        if (this._options.hostProtocol === "TunnelUDP") {
            this._clientSocket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
            this._clientSocket.on(SocketEvents.message, this._processInboundMessage);
            this._clientSocket.on(SocketEvents.error, error => this.emit(KNXClientEvents.error, error));
            this._clientSocket.on(SocketEvents.close, info => this.emit(KNXClientEvents.close, info));
            this._clientSocket.bind({ address: this._options.localIPAddress, port: this._options._peerPort }, () => {
                try {
                    conn._clientSocket.setTTL(128);
                } catch (error) {
                    if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.error("UDP:  Error setting SetTTL " + error.message || "");
                }
            });

        } else if (this._options.hostProtocol === "TunnelTCP") {
            // TCP
            this._clientSocket = new net.Socket();
            //this._clientSocket.on(SocketEvents.data, this._processInboundMessage);
            this._clientSocket.on(SocketEvents.data, function (msg, rinfo, callback) {
                console.log(msg, rinfo, callback);
            });
            this._clientSocket.on(SocketEvents.error, error => this.emit(KNXClientEvents.error, error));
            this._clientSocket.on(SocketEvents.close, info => this.emit(KNXClientEvents.close, info));

        } else if (this._options.hostProtocol === "Multicast") {
            let conn = this;
            this._clientSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            this._clientSocket.on(SocketEvents.listening, function () {
                try {
                    conn._clientSocket.addMembership(conn._peerHost, conn._options.localIPAddress);
                } catch (err) {
                    if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.error("Multicast: cannot add membership (%s)", err);
                    try {
                        this.emit(KNXClientEvents.error, err);
                    } catch (error) { }
                    return;
                }
            });
            this._clientSocket.on(SocketEvents.message, this._processInboundMessage);
            this._clientSocket.on(SocketEvents.error, error => this.emit(KNXClientEvents.error, error));
            this._clientSocket.on(SocketEvents.close, info => this.emit(KNXClientEvents.close, info));
            this._clientSocket.bind(this._peerPort, () => {
                try {
                    conn._clientSocket.setMulticastTTL(128);
                    conn._clientSocket.setMulticastInterface(this._options.localIPAddress);
                } catch (error) {
                    if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.error("Multicast: Error setting SetTTL " + error.message || "");
                }
                this._localPort = this._clientSocket.address().port;// 07/12/2021 Get the local port used bu the socket
            });
        }

        this._clientTunnelSeqNumber = 0;
        this._channelID = null;
        this._connectionState = STATE.DISCONNECTED;
        this._tunnelReqTimer = new Map();

    }
    get channelID() {
        return this._channelID;
    }
    // Transform the plain value "data" into a KNXDataBuffer
    getKNXDataBuffer(_data, _dptid) {
        let adpu = {};
        DPTLib.populateAPDU(_data, adpu, _dptid);
        let IDataPoint = {
            id: "",
            value: "any",
            type: { type: adpu.bitlength.toString() || null },
            bind: null,
            read: () => null,
            write: null
        }
        return new KNXDataBuffer(adpu.data, IDataPoint);
    }
    bindSocketPortAsync(port = KNXConstants.KNX_CONSTANTS.KNX_PORT, host = '0.0.0.0') {
        return new Promise((resolve, reject) => {
            try {
                this._clientSocket.bind(port, host, () => {
                    this._clientSocket.setMulticastInterface(host);
                    this._clientSocket.setMulticastTTL(128);
                    this._options.localIPAddress = host;
                    resolve();
                });
            }
            catch (err) {
                reject(err);
            }
        });
    }
    send(knxPacket) {
        // Logging
        if (this.sysLogger !== undefined && this.sysLogger !== null) {
            try {
                if (knxPacket.constructor.name !== undefined && knxPacket.constructor.name.toLowerCase() === "knxconnectrequest") this.sysLogger.debug("Sending KNX packet: " + knxPacket.constructor.name + " Host:" + this._peerHost + ":" + this._peerPort);
                if (knxPacket.constructor.name !== undefined && knxPacket.constructor.name.toLowerCase() === "knxtunnelingrequest") {
                    let sTPCI = ""
                    if (knxPacket.cEMIMessage.npdu.isGroupRead) sTPCI = "Read";
                    if (knxPacket.cEMIMessage.npdu.isGroupResponse) sTPCI = "Response";
                    if (knxPacket.cEMIMessage.npdu.isGroupWrite) sTPCI = "Write";
                    this.sysLogger.debug("Sending KNX packet: " + knxPacket.constructor.name + " Host:" + this._peerHost + ":" + this._peerPort + " channelID:" + knxPacket.channelID + " seqCounter:" + knxPacket.seqCounter + " Dest:" + knxPacket.cEMIMessage.dstAddress.toString(), " Data:" + knxPacket.cEMIMessage.npdu.dataValue.toString("hex") + " TPCI:" + sTPCI);
                }
            } catch (error) {
                this.sysLogger.debug("Sending KNX packet error " + error.message || "");
            }
        }

        // Real send to KNX wires
        if (this._options.hostProtocol === "Multicast" || this._options.hostProtocol === "TunnelUDP") {
            // UDP
            try {
                this._clientSocket.send(knxPacket.toBuffer(), this._peerPort, this._peerHost, err => {
                    if (err) {
                        if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.error("KNXClient: Send UDP: " + err.message || "Undef error");
                        try {
                            this.emit(KNXClientEvents.error, err);
                        } catch (error) {
                        }
                    }
                   
                });
            } catch (error) {
                if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.debug("Sending KNX packet via TCP: " + typeof (knxPacket) + " seqCounter:" + knxPacket.seqCounter);
                try {
                    //this.emit(KNXClientEvents.error, error);
                } catch (error) {
                }

            }
        } else {
            // TCP
            try {
                this._clientSocket.write(knxPacket.toBuffer(), err => {
                    if (err) {
                        if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.error("KNXClient: Send TCP: " + err.message || "Undef error");
                        this.emit(KNXClientEvents.error, err);
                    }
                  
                });
            } catch (error) {
                if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.error("KNXClient: Send TCP Catch: " + error.message || "Undef error");
                try {
                    //this.emit(KNXClientEvents.error, error);
                } catch (error) {
                }

            }
        }
    }

    /**
    *
    * @param {KNXAddress} srcAddress
    * @param {KNXAddress} dstAddress
    * @param {KNXDataBuffer} data
    * @param {function} cb
    */
    // sendWriteRequest(dstAddress, data) {
    write(dstAddress, data, dptid) {

        if (this._connectionState !== STATE.CONNECTED) throw new Error("The socket is not connected. Unable to access the KNX BUS");

        // Get the Data Buffer from the plain value
        data = this.getKNXDataBuffer(data, dptid);

        if (typeof dstAddress === "string") dstAddress = KNXAddress.createFromString(dstAddress, KNXAddress.TYPE_GROUP);
        let srcAddress = this._options.physAddr;

        if (this._options.hostProtocol === "Multicast") {
            // Multicast
            const cEMIMessage = CEMIFactory.CEMIFactory.newLDataRequestMessage("write", srcAddress, dstAddress, data);
            cEMIMessage.control.ack = 0;
            cEMIMessage.control.broadcast = 1;
            cEMIMessage.control.priority = 3;
            cEMIMessage.control.addressType = 1;
            cEMIMessage.control.hopCount = 6;
            const knxPacketRequest = KNXProtocol.KNXProtocol.newKNXRoutingIndication(cEMIMessage);
            this.send(knxPacketRequest);
            // 06/12/2021 Echo the sent telegram.
            try {
                this.emit(KNXClientEvents.indication, knxPacketRequest, true, null);
            } catch (error) {
            }

        } else {
            // Tunneling
            const cEMIMessage = CEMIFactory.CEMIFactory.newLDataRequestMessage("write", srcAddress, dstAddress, data);
            cEMIMessage.control.ack = this._options.suppress_ack_ldatareq ? 0 : 1;
            cEMIMessage.control.broadcast = 1;
            cEMIMessage.control.priority = 3;
            cEMIMessage.control.addressType = 1;
            cEMIMessage.control.hopCount = 6;
            const seqNum = this._getSeqNumber();
            const knxPacketRequest = KNXProtocol.KNXProtocol.newKNXTunnelingRequest(this._channelID, seqNum, cEMIMessage);
            if (!this._options.suppress_ack_ldatareq) this._setTimerAndCallback(knxPacketRequest);
            this.send(knxPacketRequest);
            // 06/12/2021 Echo the sent telegram. Last parameter is the echo true/false
            try {
                if (this._options.localEchoInTunneling) this.emit(KNXClientEvents.indication, knxPacketRequest, true, null);
            } catch (error) {
            }

        }

    }
    // sendResponseRequest
    respond(dstAddress, data, dptid) {

        if (this._connectionState !== STATE.CONNECTED) throw new Error("The socket is not connected. Unable to access the KNX BUS");

        // Get the Data Buffer from the plain value
        data = this.getKNXDataBuffer(data, dptid);

        if (typeof dstAddress === "string") dstAddress = KNXAddress.createFromString(dstAddress, KNXAddress.TYPE_GROUP);
        let srcAddress = this._options.physAddr;

        if (this._options.hostProtocol === "Multicast") {
            // Multicast
            const cEMIMessage = CEMIFactory.CEMIFactory.newLDataRequestMessage("response", srcAddress, dstAddress, data);
            cEMIMessage.control.ack = 0;
            cEMIMessage.control.broadcast = 1;
            cEMIMessage.control.priority = 3;
            cEMIMessage.control.addressType = 1;
            cEMIMessage.control.hopCount = 6;
            const knxPacketRequest = KNXProtocol.KNXProtocol.newKNXRoutingIndication(cEMIMessage);
            this.send(knxPacketRequest);
            // 06/12/2021 Echo the sent telegram. Last parameter is the echo true/false
            try {
                if (this._options.localEchoInTunneling) this.emit(KNXClientEvents.indication, knxPacketRequest, true, null);
            } catch (error) {
            }

        } else {
            // Tunneling
            const cEMIMessage = CEMIFactory.CEMIFactory.newLDataRequestMessage("response", srcAddress, dstAddress, data);
            cEMIMessage.control.ack = this._options.suppress_ack_ldatareq ? 0 : 1;
            cEMIMessage.control.broadcast = 1;
            cEMIMessage.control.priority = 3;
            cEMIMessage.control.addressType = 1;
            cEMIMessage.control.hopCount = 6;
            const seqNum = this._getSeqNumber();
            const knxPacketRequest = KNXProtocol.KNXProtocol.newKNXTunnelingRequest(this._channelID, seqNum, cEMIMessage);
            if (!this._options.suppress_ack_ldatareq) this._setTimerAndCallback(knxPacketRequest);
            this.send(knxPacketRequest);
            // 06/12/2021 Echo the sent telegram. Last parameter is the echo true/false
            try {
                if (this._options.localEchoInTunneling) this.emit(KNXClientEvents.indication, knxPacketRequest, true, null);
            } catch (error) {
            }

        }

    }
    // sendReadRequest
    read(dstAddress) {

        if (this._connectionState !== STATE.CONNECTED) throw new Error("The socket is not connected. Unable to access the KNX BUS");

        if (typeof dstAddress === "string") dstAddress = KNXAddress.createFromString(dstAddress, KNXAddress.TYPE_GROUP);
        let srcAddress = this._options.physAddr;

        if (this._options.hostProtocol === "Multicast") {
            // Multicast
            const cEMIMessage = CEMIFactory.CEMIFactory.newLDataRequestMessage("read", srcAddress, dstAddress, null);
            cEMIMessage.control.ack = 0;
            cEMIMessage.control.broadcast = 1;
            cEMIMessage.control.priority = 3;
            cEMIMessage.control.addressType = 1;
            cEMIMessage.control.hopCount = 6;
            const knxPacketRequest = KNXProtocol.KNXProtocol.newKNXRoutingIndication(cEMIMessage);
            this.send(knxPacketRequest);
            // 06/12/2021 Echo the sent telegram. Last parameter is the echo true/false
            try {
                if (this._options.localEchoInTunneling) this.emit(KNXClientEvents.indication, knxPacketRequest, true, null);
            } catch (error) {
            }

        } else {
            // Tunneling
            const cEMIMessage = CEMIFactory.CEMIFactory.newLDataRequestMessage("read", srcAddress, dstAddress, null);
            cEMIMessage.control.ack = 0;// No ack like telegram sent from ETS
            cEMIMessage.control.broadcast = 1;
            cEMIMessage.control.priority = 3;
            cEMIMessage.control.addressType = 1;
            cEMIMessage.control.hopCount = 6;
            const seqNum = this._getSeqNumber();
            const knxPacketRequest = KNXProtocol.KNXProtocol.newKNXTunnelingRequest(this._channelID, seqNum, cEMIMessage);
            if (!this._options.suppress_ack_ldatareq) this._setTimerAndCallback(knxPacketRequest);
            this.send(knxPacketRequest);
            // 06/12/2021 Echo the sent telegram. Last parameter is the echo true/false
            try {
                if (this._options.localEchoInTunneling) this.emit(KNXClientEvents.indication, knxPacketRequest, true, null);
            } catch (error) {
            }

        }

    }
    writeRaw(dstAddress, _rawDataBuffer, bitlength) {
        // bitlength is unused and only for backward compatibility

        if (this._connectionState !== STATE.CONNECTED) throw new Error("The socket is not connected. Unable to access the KNX BUS");

        if (!Buffer.isBuffer(_rawDataBuffer)) {
            if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.error('KNXClient: writeRaw: Value must be a buffer! ');
            return
        }

        // Transform the  "data" into a KNDDataBuffer
        let data = new KNXDataBuffer(_rawDataBuffer)

        if (typeof dstAddress === "string") dstAddress = KNXAddress.createFromString(dstAddress, KNXAddress.TYPE_GROUP);
        let srcAddress = this._options.physAddr;
        if (this._options.hostProtocol === "Multicast") {
            // Multicast
            const cEMIMessage = CEMIFactory.CEMIFactory.newLDataRequestMessage("write", srcAddress, dstAddress, data);
            cEMIMessage.control.ack = 0;
            cEMIMessage.control.broadcast = 1;
            cEMIMessage.control.priority = 3;
            cEMIMessage.control.addressType = 1;
            cEMIMessage.control.hopCount = 6;
            const knxPacketRequest = KNXProtocol.KNXProtocol.newKNXRoutingIndication(cEMIMessage);
            this.send(knxPacketRequest);
            // 06/12/2021 Echo the sent telegram. Last parameter is the echo true/false
            try {
                this.emit(KNXClientEvents.indication, knxPacketRequest, true, null);
            } catch (error) {
            }

        } else {
            // Tunneling
            const cEMIMessage = CEMIFactory.CEMIFactory.newLDataRequestMessage("write", srcAddress, dstAddress, data);
            cEMIMessage.control.ack = this._options.suppress_ack_ldatareq ? 0 : 1;
            cEMIMessage.control.broadcast = 1;
            cEMIMessage.control.priority = 3;
            cEMIMessage.control.addressType = 1;
            cEMIMessage.control.hopCount = 6;
            const seqNum = this._getSeqNumber();
            const knxPacketRequest = KNXProtocol.KNXProtocol.newKNXTunnelingRequest(this._channelID, seqNum, cEMIMessage);
            if (!this._options.suppress_ack_ldatareq) this._setTimerAndCallback(knxPacketRequest);
            this.send(knxPacketRequest);
            // 06/12/2021 Echo the sent telegram. Last parameter is the echo true/false
            try {
                if (this._options.localEchoInTunneling) this.emit(KNXClientEvents.indication, knxPacketRequest, true, null);
            } catch (error) {
            }

        }

    }
    startHeartBeat() {
        this.stopHeartBeat();
        this._heartbeatFailures = 0;
        this._heartbeatRunning = true;
        this._runHeartbeat();
    }
    stopHeartBeat() {
        if (this._heartbeatTimer !== null) {
            this._heartbeatRunning = false;
            clearTimeout(this._heartbeatTimer);
        }
    }
    isDiscoveryRunning() {
        return this._discovery_timer != null;
    }
    startDiscovery() {
        if (this.isDiscoveryRunning()) {
            throw new Error('Discovery already running');
        }
        this._discovery_timer = setTimeout(() => {
            this._discovery_timer = null;
        }, 1000 * KNXConstants.KNX_CONSTANTS.SEARCH_TIMEOUT);
        this._sendSearchRequestMessage();
    }
    stopDiscovery() {
        if (!this.isDiscoveryRunning()) {
            return;
        }
        if (this._discovery_timer !== null) clearTimeout(this._discovery_timer);
        this._discovery_timer = null;
    }
    getDescription(host, port) {
        if (this._clientSocket == null) {
            throw new Error('No client socket defined');
        }
        this._timer = setTimeout(() => {
            this._timer = null;
        }, 1000 * KNXConstants.KNX_CONSTANTS.DEVICE_CONFIGURATION_REQUEST_TIMEOUT);
        this._awaitingResponseType = KNXConstants.KNX_CONSTANTS.DESCRIPTION_RESPONSE;
        this._sendDescriptionRequestMessage(host, port);
    }
    Connect(knxLayer = TunnelCRI.TunnelTypes.TUNNEL_LINKLAYER) {

        if (this._clientSocket == null) {
            throw new Error('No client socket defined');
        }
        if (this._connectionState === STATE.DISCONNECTING) {
            throw new Error('Socket is disconnecting. Please wait until disconnected.');
        }
        if (this._connectionState === STATE.CONNECTING) {
            throw new Error('Socket is connecting. Please wait until connected.');
        }
        if (this._connectionState === STATE.CONNECTED) {
            throw new Error('Socket is already connected. Disconnect first.');
        }

        this._connectionState = STATE.CONNECTING;

        if (this._timer !== null) clearTimeout(this._timer);

        // Emit connecting
        this.emit(KNXClientEvents.connecting, this._options);


        if (this._options.hostProtocol === "TunnelUDP") {

            // Unicast, need to explicitly create the connection
            const timeoutError = new Error(`Connection timeout to ${this._peerHost}:${this._peerPort}`);
            this._timer = setTimeout(() => {
                this._timer = null;
                try {
                    this.emit(KNXClientEvents.error, timeoutError);
                } catch (error) {
                }

            }, 1000 * KNXConstants.KNX_CONSTANTS.CONNECT_REQUEST_TIMEOUT);
            this._awaitingResponseType = KNXConstants.KNX_CONSTANTS.CONNECT_RESPONSE;
            this._clientTunnelSeqNumber = 0;
            this._sendConnectRequestMessage(new TunnelCRI.TunnelCRI(knxLayer));

        } else if (this._options.hostProtocol === "TunnelTCP") {

            // TCP
            const timeoutError = new Error(`Connection timeout to ${this._peerHost}:${this._peerPort}`);
            let conn = this;
            this._clientSocket.connect({ port: this._peerPort, host: this._peerHost, localAddress: this._options.localAddress }, function () {
                // conn._timer = setTimeout(() => {
                //     conn._timer = null;
                //     conn.emit(KNXClientEvents.error, timeoutError);
                // }, 1000 * KNXConstants.KNX_CONSTANTS.CONNECT_REQUEST_TIMEOUT);
                conn._awaitingResponseType = KNXConstants.KNX_CONSTANTS.CONNECT_RESPONSE;
                conn._clientTunnelSeqNumber = 0;
                if (conn._options.isSecureKNXEnabled) conn._sendSecureSessionRequestMessage(new TunnelCRI.TunnelCRI(knxLayer));
            });


        } else {

            // Multicast
            this._connectionState = STATE.CONNECTED;
            this._clientTunnelSeqNumber = 0;
            try {
                this.emit(KNXClientEvents.connected, this._options);
            } catch (error) {
            }

        }
    }
    getConnectionStatus() {

        if (this._clientSocket == null) {
            throw new Error('No client socket defined');
        }
        const timeoutError = new Error(`HeartBeat failure with ${this._peerHost}:${this._peerPort}`);
        const deadError = new Error(`Connection dead with ${this._peerHost}:${this._peerPort}`);
        this._heartbeatTimer = setTimeout(() => {
            this._heartbeatTimer = null;
            try {
                console.log("BANANA OH! getConnectionStatus Timeout", this._heartbeatFailures, "su", this.max_HeartbeatFailures);
                //this.emit(KNXClientEvents.error, timeoutError);
            } catch (error) {
            }

            this._heartbeatFailures++;
            if (this._heartbeatFailures >= this.max_HeartbeatFailures) {
                this._heartbeatFailures = 0;
                try {
                    this.emit(KNXClientEvents.error, deadError);
                } catch (error) {
                }
                this._setDisconnected();
            }
        }, 1000 * KNXConstants.KNX_CONSTANTS.CONNECTIONSTATE_REQUEST_TIMEOUT);
        this._awaitingResponseType = KNXConstants.KNX_CONSTANTS.CONNECTIONSTATE_RESPONSE;
        this._sendConnectionStateRequestMessage(this._channelID);
    }
    Disconnect() {
        if (this._clientSocket == null) {
            throw new Error('No client socket defined');
        }
        this.stopHeartBeat();
        this._connectionState = STATE.DISCONNECTING;
        this._timer = setTimeout(() => {
            this._timer = null;
        }, 1000 * KNXConstants.KNX_CONSTANTS.CONNECT_REQUEST_TIMEOUT);
        this._awaitingResponseType = KNXConstants.KNX_CONSTANTS.DISCONNECT_RESPONSE;
        this._sendDisconnectRequestMessage(this._channelID);
        this._timerTimeoutSendDisconnectRequestMessage = setTimeout(() => {
            this._setDisconnected();
        }, 1000 * KNXConstants.KNX_CONSTANTS.CONNECT_REQUEST_TIMEOUT);
    }
    isConnected() {
        return this._connectionState === STATE.CONNECTED;
    }
    _setDisconnected() {
        if (this._timerTimeoutSendDisconnectRequestMessagetimer !== null) clearTimeout(this._timerTimeoutSendDisconnectRequestMessagetimer);
        this._timerTimeoutSendDisconnectRequestMessage = null;
        if (this._timer !== null) clearTimeout(this._timer);
        this.stopHeartBeat();
        this._connectionState = STATE.DISCONNECTED;
        try {
            this.emit(KNXClientEvents.disconnected, `${this._options.ipAddr}:${this._options.ipPort}`);
        } catch (error) {
        }

        this._clientTunnelSeqNumber = 0;
        this._channelID = null;
        this._tunnelReqTimer = new Map();
        // 08/12/2021
        try {
            this._clientSocket.close();
        } catch (error) { }

    }
    _runHeartbeat() {
        if (this._heartbeatRunning) {
            this.getConnectionStatus();
            setTimeout(() => {
                this._runHeartbeat();
            }, 1000 * this._options.connectionKeepAliveTimeout);
        }
    }
    _getSeqNumber() {
        return this._clientTunnelSeqNumber;
    }
    _incSeqNumber(seq) {
        this._clientTunnelSeqNumber = seq ? seq + 1 : this._clientTunnelSeqNumber + 1;
        if (this._clientTunnelSeqNumber > 255) {
            this._clientTunnelSeqNumber = 0;
        }
        return this._clientTunnelSeqNumber;
    }

    _keyFromCEMIMessage(cEMIMessage) {
        return cEMIMessage.dstAddress.toString();
    }
    _setTimerAndCallback(knxTunnelingRequest) {
        const timeoutErr = new errors.RequestTimeoutError(`RequestTimeoutError seqCounter:${knxTunnelingRequest.seqCounter}, DestAddr:${knxTunnelingRequest.cEMIMessage.dstAddress.toString() || "Non definito"},  AckRequested:${knxTunnelingRequest.cEMIMessage.control.ack}, timed out waiting telegram acknowledge by ${this._options.ipAddr || "No Peer host detected"}`);
        //const key = this._keyFromCEMIMessage(knxTunnelingRequest.cEMIMessage);
        this._tunnelReqTimer.set(knxTunnelingRequest.seqCounter, setTimeout(() => {
            this._tunnelReqTimer.delete(knxTunnelingRequest.seqCounter);
            if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.error("KNXClient: _setTimerAndCallback: " + (timeoutErr.message || "Undef error"));
            try {
                this.emit(KNXClientEvents.error, timeoutErr);
            } catch (error) {
            }
        }, KNXConstants.KNX_CONSTANTS.TUNNELING_REQUEST_TIMEOUT * 1000));
    }
    _processInboundMessage(msg, rinfo) {
        try {
            const { knxHeader, knxMessage } = KNXProtocol.KNXProtocol.parseMessage(msg);

            if (knxHeader.service_type === KNXConstants.KNX_CONSTANTS.SEARCH_RESPONSE) {
                if (this._discovery_timer == null) {
                    return;
                }
                try {
                    this.emit(KNXClientEvents.discover, `${rinfo.address}:${rinfo.port}`, knxHeader, knxMessage);
                } catch (error) {
                }

            }
            else if (knxHeader.service_type === KNXConstants.KNX_CONSTANTS.CONNECT_RESPONSE) {
                if (this._connectionState === STATE.CONNECTING) {
                    if (this._timer !== null) clearTimeout(this._timer);
                    this._timer = null;
                    const knxConnectResponse = knxMessage;
                    if (knxConnectResponse.status !== KNXConstants.ConnectionStatus.E_NO_ERROR) {
                        try {
                            this.emit(KNXClientEvents.error, KNXConnectResponse.KNXConnectResponse.statusToString(knxConnectResponse.status));
                        } catch (error) {
                        }
                        this._setDisconnected();
                        return;
                    }
                    this._connectionState = STATE.CONNECTED;
                    this._channelID = knxConnectResponse.channelID;
                    try {
                        if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.debug("Received KNX packet: CONNECT_RESPONSE, ChannelID:" + this._channelID + " Host:" + this._options.ipAddr + ":" + this._options.ipPort);
                    } catch (error) { }
                    try {
                        this.emit(KNXClientEvents.connected, this._options);
                    } catch (error) {
                    }
                    this.startHeartBeat();
                }
            }
            else if (knxHeader.service_type === KNXConstants.KNX_CONSTANTS.DISCONNECT_RESPONSE) {

                try {
                    if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.debug("Received KNX packet: DISCONNECT_RESPONSE, ChannelID:" + this._channelID + " Host:" + this._options.ipAddr + ":" + this._options.ipPort);
                } catch (error) { }

                if (this._connectionState !== STATE.DISCONNECTING) {
                    try {
                        this.emit(KNXClientEvents.error, new Error('Unexpected Disconnect Response.'));
                    } catch (error) {
                    }
                }
                this._setDisconnected();
            }
            else if (knxHeader.service_type === KNXConstants.KNX_CONSTANTS.DISCONNECT_REQUEST) {

                const knxDisconnectRequest = knxMessage;
                if (knxDisconnectRequest.channelID !== this._channelID) {
                    return;
                }

                try {
                    if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.debug("Received KNX packet: DISCONNECT_REQUEST, ChannelID:" + this._channelID + " Host:" + this._options.ipAddr + ":" + this._options.ipPort);
                } catch (error) { }

                this._connectionState = STATE.DISCONNECTING;
                this._sendDisconnectResponseMessage(knxDisconnectRequest.channelID);
                this._setDisconnected();
            }
            else if (knxHeader.service_type === KNXConstants.KNX_CONSTANTS.TUNNELING_REQUEST) {

                const knxTunnelingRequest = knxMessage;
                if (knxTunnelingRequest.channelID !== this._channelID) {
                    return;
                }

                if (knxTunnelingRequest.cEMIMessage.msgCode === CEMIConstants.CEMIConstants.L_DATA_IND) {

                    try {
                        if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.debug("Received KNX packet: TUNNELING_REQUEST L_DATA_IND, ChannelID:" + this._channelID + " seqCounter:" + knxTunnelingRequest.seqCounter + " Host:" + this._options.ipAddr + ":" + this._options.ipPort);
                    } catch (error) { }

                    try {
                        this.emit(KNXClientEvents.indication, knxTunnelingRequest, false, msg.toString("hex"));
                    } catch (error) {
                    }

                }
                else if (knxTunnelingRequest.cEMIMessage.msgCode === CEMIConstants.CEMIConstants.L_DATA_CON) {

                    try {
                        if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.debug("Received KNX packet: TUNNELING_REQUEST L_DATA_CON, ChannelID:" + this._channelID + " seqCounter:" + knxTunnelingRequest.seqCounter + " Host:" + this._options.ipAddr + ":" + this._options.ipPort);
                    } catch (error) { }

                }
                const knxTunnelAck = KNXProtocol.KNXProtocol.newKNXTunnelingACK(knxTunnelingRequest.channelID, knxTunnelingRequest.seqCounter, KNXConstants.KNX_CONSTANTS.E_NO_ERROR);
                this.send(knxTunnelAck);
            }
            else if (knxHeader.service_type === KNXConstants.KNX_CONSTANTS.TUNNELING_ACK) {
                //const knxTunnelingAck =  lodash.cloneDeep(knxMessage);
                const knxTunnelingAck = knxMessage;
                if (knxTunnelingAck.channelID !== this._channelID) {
                    return;
                }

                try {
                    if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.debug("Received KNX packet: TUNNELING_ACK, ChannelID:" + this._channelID + " seqCounter:" + knxTunnelingAck.seqCounter + " Host:" + this._options.ipAddr + ":" + this._options.ipPort);
                } catch (error) { }

                this._incSeqNumber(knxTunnelingAck.seqCounter);

                if (this._tunnelReqTimer.has(knxTunnelingAck.seqCounter)) {
                    if (this._tunnelReqTimer.get(knxTunnelingAck.seqCounter) !== null) clearTimeout(this._tunnelReqTimer.get(knxTunnelingAck.seqCounter));
                    this._tunnelReqTimer.delete(knxTunnelingAck.seqCounter);
                    try {
                        if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.debug("_processInboundMessage: DELETED_TUNNELING_ACK FROM PENDING ACK's, ChannelID:" + this._channelID + " seqCounter:" + knxTunnelingAck.seqCounter + " Host:" + this._options.ipAddr + ":" + this._options.ipPort);
                    } catch (error) { }
                }
                else {

                    // Avoid warning if the KNXEngine is set to ignore ACK's telegrams
                    if (!this._options.suppress_ack_ldatareq) {
                        try {
                            if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.error("_processInboundMessage: Unexpected Tunnel Ack with seqCounter = " + knxTunnelingAck.seqCounter);
                        } catch (error) { }
                        //this.emit(KNXClientEvents.error, `Unexpected Tunnel Ack ${knxTunnelingAck.seqCounter}`);
                    }
                }

            } else if (knxHeader.service_type === KNXConstants.KNX_CONSTANTS.ROUTING_INDICATION) {
                // 07/12/2021 Multicast routing indication
                const knxRoutingInd = knxMessage;
                if (knxRoutingInd.cEMIMessage.msgCode === CEMIConstants.CEMIConstants.L_DATA_IND) {
                    try {
                        this.emit(KNXClientEvents.indication, knxRoutingInd, false, msg.toString("hex"));                        
                    } catch (error) {
                    }
                }
                else if (knxRoutingInd.cEMIMessage.msgCode === CEMIConstants.CEMIConstants.L_DATA_CON) {

                }

            } else if (knxHeader.service_type === KNXConstants.KNX_CONSTANTS.ROUTING_LOST_MESSAGE) {
                // Multicast, ho perso il mondo dei messaggi

            } else {
                if (knxHeader.service_type === this._awaitingResponseType) {
                    if (this._awaitingResponseType === KNXConstants.KNX_CONSTANTS.CONNECTIONSTATE_RESPONSE) {

                        try {
                            if (this.sysLogger !== undefined && this.sysLogger !== null) this.sysLogger.debug("Received KNX packet: CONNECTIONSTATE_RESPONSE, ChannelID:" + this._channelID + " Host:" + this._options.ipAddr + ":" + this._options.ipPort);
                        } catch (error) { }

                        const knxConnectionStateResponse = knxMessage;
                        if (knxConnectionStateResponse.status !== KNXConstants.KNX_CONSTANTS.E_NO_ERROR) {
                            try {
                                this.emit(KNXClientEvents.error, KNXConnectionStateResponse.KNXConnectionStateResponse.statusToString(knxConnectionStateResponse.status));
                            } catch (error) {
                            }
                            this._setDisconnected();
                        }
                        else {
                            if (this._heartbeatTimer !== null) clearTimeout(this._heartbeatTimer);
                            this._heartbeatFailures = 0;
                        }
                    }
                    else {
                        if (this._timer !== null) clearTimeout(this._timer);
                    }
                }
                try {
                    this.emit(KNXClientEvents.response, `${rinfo.address}:${rinfo.port}`, knxHeader, knxMessage);
                } catch (error) {
                }

            }
        }
        catch (e) {
            try {
                this.emit(KNXClientEvents.error, e);
            } catch (error) { }

        }

    }

    _sendDescriptionRequestMessage() {
        this.send(KNXProtocol.KNXProtocol.newKNXDescriptionRequest(new HPAI.HPAI(this._options.localIPAddress)));
    }
    _sendSearchRequestMessage() {
        console.log('_sendSearchRequestMessage', this._options.localIPAddress, this._localPort);
        this.send(KNXProtocol.KNXProtocol.newKNXSearchRequest(new HPAI.HPAI(this._options.localIPAddress, this._localPort)), KNXConstants.KNX_CONSTANTS.KNX_PORT, KNXConstants.KNX_CONSTANTS.KNX_IP);
    }
    _sendConnectRequestMessage(cri) {
        this.send(KNXProtocol.KNXProtocol.newKNXConnectRequest(cri));
    }
    _sendConnectionStateRequestMessage(channelID) {
        this.send(KNXProtocol.KNXProtocol.newKNXConnectionStateRequest(channelID));
    }
    _sendDisconnectRequestMessage(channelID) {
        this.send(KNXProtocol.KNXProtocol.newKNXDisconnectRequest(channelID));
    }
    _sendDisconnectResponseMessage(channelID, status = KNXConstants.ConnectionStatus.E_NO_ERROR) {
        this.send(KNXProtocol.KNXProtocol.newKNXDisconnectResponse(channelID, status));
    }
    _sendSecureSessionRequestMessage(cri) {
        let oHPAI = new HPAI.HPAI("0.0.0.0", 0, this._options.hostProtocol === "TunnelTCP" ? KNXConstants.KNX_CONSTANTS.IPV4_TCP : KNXConstants.KNX_CONSTANTS.IPV4_UDP);
        this.send(KNXProtocol.KNXProtocol.newKNXSecureSessionRequest(cri, oHPAI));
    }
}

// module.exports = function KNXClientEvents() {
//     return KNXClientEvents;
// }
module.exports = {
    KNXClient: KNXClient,
    KNXClientEvents: KNXClientEvents
};
//exports.KNXClient = KNXClient;
//exports.KNXClientEvents = KNXClientEvents;
