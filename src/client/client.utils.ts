
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import type { ClientCredentials, CommandResponse, PasswordCredentials, TokenCredentials } from './client.type.js';
import { translateCommandCode } from '../wire/command.code.js';
import { responseError } from '../wire/error.utils.js';
import { LOGIN } from '../wire/session/login.command.js';
import { LOGIN_WITH_TOKEN } from '../wire/session/login-with-token.command.js';


export const handleResponse = (r: Buffer) => {
  const status = r.readUint32LE(0);
  const length = r.readUint32LE(4);
  console.log('<== handleResponse', { status, length });
  return {
    status, length, data: r.subarray(8)
  }
};

export const deserializeVoidResponse =
  (r: CommandResponse) => r.status === 0 && r.data.length === 0;

const COMMAND_LENGTH = 4;

export const serializeCommand = (command: number, payload: Buffer) => {
  const payloadSize = payload.length + COMMAND_LENGTH;
  const head = Buffer.allocUnsafe(8);

  head.writeUint32LE(payloadSize, 0);
  head.writeUint32LE(command, 4);

  console.log(
    '==> CMD', command,
    translateCommandCode(command),
    head.subarray(4, 8).toString('hex'),
    'LENGTH', payloadSize,
    head.subarray(0, 4).toString('hex')
  );

  return Buffer.concat([head, payload]);
}


export const wrapSocket = (socket: Socket) =>
  new Promise<CommandResponseStream>((resolve, reject) => {
    const responseStream = new CommandResponseStream(socket);

    socket.on('error', (err: unknown) => {
      console.error('RESPONSESTREAM ERROR', err)
      reject(err);
    });
    socket.once('connect', () => {
      console.log('responseStream.connect event !');
      resolve(responseStream);
    });
    socket.on('close', () => { console.error('#CLOSE'); reject(); });
    socket.on('end', () => { console.error('#END'); reject(); });
  });


type WriteCb = ((error: Error | null | undefined) => void) | undefined

type Job = {
  command: number,
  payload: Buffer,
  resolve: (v: any) => void,
  reject: (e: any) => void
};

export class CommandResponseStream extends Duplex {
  private _socket: Socket;
  private _readPaused: boolean;
  private _execQueue: Job[];
  public busy: boolean;
  isAuthenticated: boolean;
  userId?: number;
  

  constructor(socket: Socket) {
    super();
    this._socket = this._wrapSocket(socket);
    this._readPaused = false;
    this.busy = false;
    this._execQueue = [];
    this.isAuthenticated = false;
  }

  _read(size: number): void {
    this._readPaused = false;
    setImmediate(this._onReadable.bind(this));
  }

  _write(chunk: Buffer, encoding: BufferEncoding | undefined, cb?: WriteCb) {
    return this._socket.write(chunk, encoding, cb);
  };

  writeCommand(command: number, payload: Buffer): boolean {
    const cmd = serializeCommand(command, payload);
    return this._socket.write(cmd);
  }

  sendCommand(command: number, payload: Buffer): Promise<CommandResponse> {
    return new Promise((resolve, reject) => {
      this._execQueue.push({ command, payload, resolve, reject });
      this._processQueue();
    });
  }

  async authenticate(creds: ClientCredentials) {
    const r = ('token' in creds) ?
      await this._authWithToken(creds) :
      await this._authWithPassword(creds);
    this.isAuthenticated = true;
    this.userId = r.userId;
    return this.isAuthenticated;
  }

  async _authWithPassword(creds: PasswordCredentials) {
    const pl = LOGIN.serialize(creds);
    const logr = await this.sendCommand(LOGIN.code, pl);
    return LOGIN.deserialize(logr);
  }

  async _authWithToken(creds: TokenCredentials) {
    const pl = LOGIN_WITH_TOKEN.serialize(creds);
    const logr = await this.sendCommand(LOGIN_WITH_TOKEN.code, pl);
    return LOGIN_WITH_TOKEN.deserialize(logr);    
  }
  
  async _processQueue(): Promise<void> {
    if (this.busy)
      return;
    this.busy = true;
    while (this._execQueue.length > 0) {
      const next = this._execQueue.shift();
      if (!next) break;
      const { command, payload, resolve, reject } = next;
      try {
        resolve(await this._processNext(command, payload));
      } catch (err) {
        reject(err);
      }
    }
    this.busy = false;
    this.emit('finishQueue');
  }

  _processNext(command: number, payload: Buffer): Promise<CommandResponse> {
    console.log('==> write', this.writeCommand(command, payload));
    return new Promise((resolve, reject) => {
      const errCb = (err: unknown) => reject(err);
      this.once('error', errCb);
      this.once('data', (resp) => {
        this.removeListener('error', errCb);
        const r = handleResponse(resp);
        if (r.status !== 0) {
          return reject(responseError(command, r.status));
        }
        return resolve(r);
      });
    });
  }

  _wrapSocket(socket: Socket) {
    // pass through
    socket.on('close', hadError => this.emit('close', hadError));
    socket.on('connect', () => this.emit('connect'));
    socket.on('drain', () => this.emit('drain'));
    socket.on('end', () => this.emit('end'));
    socket.on('error', err => this.emit('error', err));
    socket.on(
      'lookup',
      (err, address, family, host) => this.emit('lookup', err, address, family, host)
    );
    socket.on('ready', () => this.emit('ready'));
    socket.on('timeout', () => this.emit('timeout'));

    // customize data events
    socket.on('readable', () => this._onReadable());
    return socket;
  }

  _onReadable() {
    while (!this._readPaused) {
      const head = this._socket.read(8);
      if (!head || head.length === 0) return;
      if (head.length < 8) {
        this._socket.unshift(head);
        return;
      }
      /** first chunk[4:8] hold response length */
      const responseSize = head.readUInt32LE(4);
      /** response has no payload (create/update/delete ops...) */
      if (responseSize === 0) {
        this.push(head);
        return;
      }

      const payload = this._socket.read(responseSize);
      if (!payload) this._socket.unshift(head);
      /** payload is incomplete, unshift until next read */
      if (payload.length < responseSize) {
        this._socket.unshift(Buffer.concat([head, payload]));
        return;
      }

      const pushOk = this.push(Buffer.concat([head, payload]));
      /** consumer is slower than producer */
      if (!pushOk)
        this._readPaused = true;
    }
  }


};

// const Transports = ['TCP', 'TLS', 'QUIC'] as const;
// type TransportType = typeof Transports[number];
// type TransportOption = {};

// type TransportConfig = {
//   type: TransportType,
//   options: TransportOption;
// }

// type ClientConfig = {
//   transport: TransportConfig
// }

// export const transportClient = (config: ClientConfig): Client => {
//   const {transport} = config;
// };


