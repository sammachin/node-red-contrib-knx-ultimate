'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.KNXConnectResponse = void 0;
const KNXConstants_1 = require("./KNXConstants");
const KNXPacket_1 = require("./KNXPacket");
const HPAI_1 = require("./HPAI");
const CRD_1 = require("./CRD");
class KNXConnectResponse extends KNXPacket_1.KNXPacket {
    constructor(channelID, status, hpai, crd) {
        super(KNXConstants_1.KNX_CONSTANTS.CONNECT_RESPONSE, hpai == null ? 2 : 2 + hpai.length + crd.length);
        this.channelID = channelID;
        this.status = status;
        this.hpai = hpai;
        this.crd = crd;
    }
    static createFromBuffer(buffer, offset = 0) {
        if (offset + 2 > buffer.length) {
            throw new Error('Buffer too short');
        }
        const channelID = buffer.readUInt8(offset++);
        const status = buffer.readUInt8(offset++);
        let hpai, crd;
        if (offset < buffer.length) {
            hpai = HPAI_1.HPAI.createFromBuffer(buffer, offset);
            offset += hpai.length;
            crd = CRD_1.CRD.createFromBuffer(buffer, offset);
        }
        return new KNXConnectResponse(channelID, status, hpai, crd);
    }
    static statusToString(status) {
        switch (status) {
            case KNXConstants_1.KNX_CONSTANTS.E_SEQUENCE_NUMBER:
                return 'Invalid Sequence Number';
            case KNXConstants_1.KNX_CONSTANTS.E_CONNECTION_TYPE:
                return 'Invalid Connection Type';
            case KNXConstants_1.KNX_CONSTANTS.E_CONNECTION_OPTION:
                return 'Invalid Connection Option';
            case KNXConstants_1.KNX_CONSTANTS.E_NO_MORE_CONNECTIONS:
                return 'No More Connections';
            case KNXConstants_1.KNX_CONSTANTS.E_DATA_CONNECTION:
                return 'Invalid Data Connection';
            case KNXConstants_1.KNX_CONSTANTS.E_KNX_CONNECTION:
                return 'Invalid KNX Connection';
            case KNXConstants_1.KNX_CONSTANTS.E_TUNNELING_LAYER:
                return 'Invalid Tunneling Layer';
            default:
                return `Unknown error ${status}`;
        }
    }
    toBuffer() {
        const buffer = Buffer.alloc(2);
        buffer.writeUInt8(this.channelID, 0);
        buffer.writeUInt8(this.status, 1);
        if (this.hpai == null) {
            return buffer;
        }
        return Buffer.concat([buffer, this.hpai.toBuffer(), this.crd.toBuffer()]);
    }
}
exports.KNXConnectResponse = KNXConnectResponse;
//# sourceMappingURL=KNXConnectResponse.js.map