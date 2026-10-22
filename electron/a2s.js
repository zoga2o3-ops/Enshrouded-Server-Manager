// Minimal Steam A2S_INFO client for the Enshrouded query port.
// Returns the player count, max players, server name and map. It does not return player names.
// Whether Enshrouded answers A2S on its query port has not been confirmed against a live server yet;
// the "Probe query port" action in the client shows the raw reply so that can be checked.
'use strict';

const dgram = require('dgram');

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const INFO_REQUEST = Buffer.concat([HEADER, Buffer.from('TSource Engine Query\0', 'latin1')]);
const REPLY_INFO = 0x49; // 'I'
const REPLY_CHALLENGE = 0x41; // 'A'

// Reads an A2S_INFO reply. Throws if the buffer is not a complete reply.
function parseInfo(buf) {
  if (buf.length < 6 || !buf.subarray(0, 4).equals(HEADER) || buf[4] !== REPLY_INFO) {
    throw new Error('The query port sent something other than an A2S_INFO reply');
  }
  let pos = 5;
  const readByte = () => {
    if (pos >= buf.length) throw new Error('The query reply was cut short');
    pos += 1;
    return buf[pos - 1];
  };
  const readString = () => {
    const end = buf.indexOf(0, pos);
    if (end < 0) throw new Error('The query reply was cut short');
    const text = buf.toString('utf8', pos, end);
    pos = end + 1;
    return text;
  };
  const protocol = readByte();
  const name = readString();
  const map = readString();
  const folder = readString();
  const game = readString();
  pos += 2; // app id
  const players = readByte();
  const maxPlayers = readByte();
  const bots = readByte();
  return { protocol, name, map, folder, game, players, maxPlayers, bots };
}

// Sends A2S_INFO and resolves with the parsed reply plus the raw reply as hex.
// Servers that answer with a challenge first get the request again with that challenge attached.
function queryServer(host, port, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let finished = false;
    let timer = null;
    const finish = (err, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(value);
    };
    timer = setTimeout(() => {
      finish(new Error(`No reply from ${host}:${port}. The server may be stopped, or the query port may be blocked.`));
    }, timeoutMs);

    socket.on('error', (err) => finish(err));
    socket.on('message', (msg) => {
      if (msg.length >= 5 && msg.subarray(0, 4).equals(HEADER) && msg[4] === REPLY_CHALLENGE) {
        socket.send(Buffer.concat([INFO_REQUEST, msg.subarray(5, 9)]), port, host);
        return;
      }
      try {
        finish(null, { ...parseInfo(msg), raw_hex: msg.toString('hex') });
      } catch (err) {
        finish(err);
      }
    });
    socket.send(INFO_REQUEST, port, host, (err) => { if (err) finish(err); });
  });
}

module.exports = { queryServer, parseInfo, INFO_REQUEST };
