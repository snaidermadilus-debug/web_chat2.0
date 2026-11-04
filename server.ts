import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const app = express();
const httpServer = createServer(app);
const allowedOrigin = process.env.ALLOWED_ORIGIN;
const allowedOriginsList = allowedOrigin ? allowedOrigin.split(',').map(s => s.trim()) : null;

const io = new Server(httpServer, {
  cors: {
    origin: allowedOriginsList
      ? (origin, callback) => {
          if (!origin) return callback(null, true);
          if (allowedOriginsList.includes(origin)) {
            return callback(null, true);
          }
          try {
            const parsedUrl = new URL(origin);
            if (allowedOriginsList.includes(parsedUrl.origin) || allowedOriginsList.includes(parsedUrl.hostname)) {
              return callback(null, true);
            }
          } catch (e) {}
          callback(null, false);
        }
      : (origin, callback) => {
          if (!origin) return callback(null, true);
          try {
            const parsedUrl = new URL(origin);
            const hostname = parsedUrl.hostname;
            if (
              hostname === 'localhost' ||
              hostname === '127.0.0.1' ||
              hostname === 'run.app' ||
              hostname.endsWith('.run.app')
            ) {
              return callback(null, true);
            }
          } catch (e) {
            // invalid URL format
          }
          callback(null, false);
        },
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['polling', 'websocket'],
  maxHttpBufferSize: 16 * 1024
});

async function configureSocketAdapter() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('REDIS_URL is unset; online presence and room broadcasts are limited to this instance.');
    }
    return;
  }

  const publisher = createClient({ url: redisUrl });
  const subscriber = publisher.duplicate();
  publisher.on('error', error => console.error('Redis publisher error:', error));
  subscriber.on('error', error => console.error('Redis subscriber error:', error));
  await Promise.all([publisher.connect(), subscriber.connect()]);
  io.adapter(createAdapter(publisher, subscriber));
}

const PORT = process.env.PORT || 3000;

// Database setup
const dbPath = path.join(process.cwd(), 'chat_database.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA foreign_keys = ON;');

function cleanupOrphanedData() {
  db.exec(`
    DELETE FROM mensagens
    WHERE grupo_uuid NOT IN (SELECT grupo_uuid FROM grupos);

    DELETE FROM sessoes
    WHERE grupo_uuid NOT IN (SELECT grupo_uuid FROM grupos);
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS grupos (
    grupo_uuid TEXT PRIMARY KEY,
    grupo_id TEXT UNIQUE NOT NULL,
    criado_em TEXT NOT NULL,
    criado_por TEXT NOT NULL,
    senha_hash TEXT,
    privado BOOLEAN DEFAULT 0,
    admin_session_token TEXT,
    admin_key_hash TEXT
  );

  CREATE TABLE IF NOT EXISTS mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grupo_uuid TEXT NOT NULL,
    usuario TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    data_hora TEXT NOT NULL,
    client_msg_id TEXT,
    FOREIGN KEY (grupo_uuid) REFERENCES grupos(grupo_uuid) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    session_token TEXT PRIMARY KEY,
    grupo_uuid TEXT NOT NULL,
    usuario TEXT NOT NULL,
    device_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    recovery_secret_hash TEXT
  );
`);

// Migration to ensure admin_key_hash and improved recovery secret handling
try {
  const tableInfo = db.prepare('PRAGMA table_info(grupos)').all() as { cid: number; name: string; type: string }[];
  if (!tableInfo.find(col => col.name === 'admin_key_hash')) {
    db.exec('ALTER TABLE grupos ADD COLUMN admin_key_hash TEXT');
    console.log('✅ Migrated grupos: added admin_key_hash column');
  }
  if (!tableInfo.find(col => col.name === 'admin_session_token')) {
    db.exec('ALTER TABLE grupos ADD COLUMN admin_session_token TEXT');
    console.log('✅ Migrated grupos: added admin_session_token column');
  }
  const messageTableInfo = db.prepare('PRAGMA table_info(mensagens)').all() as { cid: number; name: string; type: string }[];
  if (!messageTableInfo.find(col => col.name === 'client_msg_id')) {
    db.exec('ALTER TABLE mensagens ADD COLUMN client_msg_id TEXT');
    console.log('✅ Migrated mensagens: added client_msg_id column');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_client_msg_id ON mensagens(grupo_uuid, client_msg_id) WHERE client_msg_id IS NOT NULL');
} catch (e: any) {
  console.error('❌ Database migration error:', e?.message || e);
}

cleanupOrphanedData();

const temp_tokens: Record<string, { grupo_id: string; usuario: string; device_id: string; socket_id: string; expires: Date }> = {};
const failed_attempts: Record<string, [number, Date]> = {};
const userCountUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const INACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000;
type MessageRateScope = 'ip' | 'session' | 'room';
const MESSAGE_RATE_LIMITS: Record<MessageRateScope, { max: number; windowMs: number }> = {
  ip: { max: 120, windowMs: 60 * 1000 },
  session: { max: 8, windowMs: 10 * 1000 },
  room: { max: 60, windowMs: 60 * 1000 }
};
const messageRateWindows: Record<MessageRateScope, Map<string, number[]>> = {
  ip: new Map(),
  session: new Map(),
  room: new Map()
};
const MESSAGE_RATE_SCOPES: MessageRateScope[] = ['ip', 'session', 'room'];

async function emitUserCountUpdate(grupoId: string) {
  try {
    const sockets = await io.in(grupoId).fetchSockets();
    io.to(grupoId).emit('user_count_update', { grupo_id: grupoId, count: sockets.length });
  } catch (error) {
    console.error('Could not update online user count:', error);
  }
}

function scheduleUserCountUpdate(grupoId: string) {
  if (userCountUpdateTimers.has(grupoId)) return;
  const timer = setTimeout(() => {
    userCountUpdateTimers.delete(grupoId);
    void emitUserCountUpdate(grupoId);
  }, 250);
  userCountUpdateTimers.set(grupoId, timer);
}

function addSocketGroup(socket: any, grupoId: string) {
  const groups = Array.isArray(socket.data.group_ids) ? socket.data.group_ids as string[] : [];
  if (!groups.includes(grupoId)) socket.data.group_ids = [...groups, grupoId];
}

function removeSocketGroup(socket: any, grupoId: string) {
  const groups = Array.isArray(socket.data.group_ids) ? socket.data.group_ids as string[] : [];
  socket.data.group_ids = groups.filter(group => group !== grupoId);
}

function sanitizeInput(text: string | number | null | undefined, maxLength = 500): string {
  if (text === null || text === undefined) return '';
  let value = String(text).trim();
  if (value.length > maxLength) {
    value = value.substring(0, maxLength);
  }
  value = value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  value = value.replace(/[\x00-\x1F\x7F]/g, '');
  return value;
}

function recordFailedAttempt(ip: string, operation: string) {
  const now = new Date();
  const key = `${ip}:${operation}`;
  if (!failed_attempts[key]) {
    failed_attempts[key] = [1, now];
  } else {
    failed_attempts[key][0] += 1;
    failed_attempts[key][1] = now;
  }
}

function checkRateLimit(ip: string, operation: string): boolean {
  const now = new Date();
  const key = `${ip}:${operation}`;
  pruneFailedAttempts();
  if (!failed_attempts[key]) return true;
  const [count, lastAttempt] = failed_attempts[key];
  if (now.getTime() > lastAttempt.getTime() + 15 * 60 * 1000) {
    failed_attempts[key] = [0, now];
    return true;
  }
  let limit = operation === 'recovery' ? 3 : operation === 'admin' ? 5 : 10;
  return count < limit;
}

function pruneFailedAttempts() {
  const now = Date.now();
  for (const key of Object.keys(failed_attempts)) {
    const [, lastAttempt] = failed_attempts[key];
    if (now - lastAttempt.getTime() > 60 * 60 * 1000) {
      delete failed_attempts[key];
    }
  }
}

function consumeMessageRateLimit(scope: MessageRateScope, key: string): boolean {
  const now = Date.now();
  const policy = MESSAGE_RATE_LIMITS[scope];
  const buckets = messageRateWindows[scope];
  const recentAttempts = (buckets.get(key) || []).filter(timestamp => now - timestamp < policy.windowMs);
  if (recentAttempts.length >= policy.max) {
    buckets.set(key, recentAttempts);
    return false;
  }
  recentAttempts.push(now);
  buckets.set(key, recentAttempts);
  return true;
}

function pruneMessageRateLimits() {
  const now = Date.now();
  for (const scope of MESSAGE_RATE_SCOPES) {
    const policy = MESSAGE_RATE_LIMITS[scope];
    const buckets = messageRateWindows[scope];
    for (const [key, timestamps] of buckets) {
      const recentAttempts = timestamps.filter(timestamp => now - timestamp < policy.windowMs);
      if (recentAttempts.length) buckets.set(key, recentAttempts);
      else buckets.delete(key);
    }
  }
}

function cleanupInactiveSessions() {
  const cutoff = new Date(Date.now() - INACTIVITY_TIMEOUT_MS).toISOString();
  db.prepare(`DELETE FROM sessoes WHERE julianday(last_seen) IS NULL OR julianday(last_seen) <= julianday(?)`).run(cutoff);
}

function cleanupTempTokens() {
  const now = Date.now();
  for (const [token, info] of Object.entries(temp_tokens)) {
    if (info.expires.getTime() <= now) delete temp_tokens[token];
  }
}

function validateSession(sessionToken: string, grupoId: string, auxiliaryDeviceId?: string): { usuario: string; device_id: string } | null {
  if (!sessionToken) return null;
  const stmt = db.prepare(`
    SELECT s.usuario, s.device_id, s.last_seen
    FROM sessoes s
    JOIN grupos g ON s.grupo_uuid = g.grupo_uuid
    WHERE s.session_token = ? AND g.grupo_id = ?
  `);
  const row = stmt.get(sessionToken, grupoId) as { usuario: string; device_id: string; last_seen: string } | undefined;
  
  if (!row) return null;
  const now = Date.now();
  const lastSeen = Date.parse(row.last_seen);
  if (!Number.isFinite(lastSeen) || now - lastSeen >= INACTIVITY_TIMEOUT_MS) {
    db.prepare(`DELETE FROM sessoes WHERE session_token = ?`).run(sessionToken);
    return null;
  }
  if (auxiliaryDeviceId && row.device_id && auxiliaryDeviceId !== row.device_id) return null;

  db.prepare(`UPDATE sessoes SET last_seen = ?, expires_at = ? WHERE session_token = ?`)
    .run(new Date(now).toISOString(), new Date(now + INACTIVITY_TIMEOUT_MS).toISOString(), sessionToken);
  return { usuario: row.usuario, device_id: row.device_id };
}

async function startServer() {
  await configureSocketAdapter();
  cleanupInactiveSessions();
  cleanupTempTokens();
  setInterval(() => {
    pruneFailedAttempts();
    pruneMessageRateLimits();
    cleanupInactiveSessions();
    cleanupTempTokens();
  }, 60 * 1000);

  io.on('connection', (socket) => {
    const clientIp = socket.handshake.address || '127.0.0.1';
    
    socket.on('disconnect', () => {
      const groups = Array.isArray(socket.data.group_ids) ? [...socket.data.group_ids] as string[] : [];
      socket.data.group_ids = [];
      for (const grupoId of groups) scheduleUserCountUpdate(grupoId);
    });

    socket.on('create_group', async (data) => {
      if (!checkRateLimit(clientIp, 'create')) return socket.emit('group_result', { success: false, msg: 'Tente mais tarde.' });
      const grupoId = sanitizeInput(data?.grupo_id || '', 32);
      const usuario = sanitizeInput(data?.usuario || '', 15);
      const password = (data?.password || '').trim();
      const isPrivate = Boolean(data?.private);
      const deviceId = (data?.device_id || '').trim();

      if (!deviceId || !grupoId || !usuario) return socket.emit('group_result', { success: false, msg: 'Dados inválidos' });
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(grupoId)) return socket.emit('group_result', { success: false, msg: 'ID do grupo inválido' });
      if (isPrivate && !password) return socket.emit('group_result', { success: false, msg: 'Grupos privados exigem uma senha.' });
      
      try {
        if (db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`).get(grupoId)) return socket.emit('group_result', { success: false, msg: 'Grupo já existe' });
        const grupoUuid = crypto.randomUUID();
        const senhaHash = isPrivate && password ? bcrypt.hashSync(password, 10) : null;
        
        const adminKey = crypto.randomBytes(32).toString('hex');
        const adminKeyHash = bcrypt.hashSync(adminKey, 10);
        const sessionToken = crypto.randomBytes(32).toString('hex');
        
        db.prepare(`INSERT INTO grupos (grupo_uuid, grupo_id, criado_em, criado_por, senha_hash, privado, admin_session_token, admin_key_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(grupoUuid, grupoId, new Date().toISOString(), usuario, senhaHash, isPrivate ? 1 : 0, sessionToken, adminKeyHash);

        // 128 bit entropy (16 bytes)
        const recoverySecret = crypto.randomBytes(16).toString('hex');
        const recoverySecretHash = bcrypt.hashSync(recoverySecret, 10);
        const expiresAt = new Date(Date.now() + INACTIVITY_TIMEOUT_MS).toISOString();
        db.prepare(`INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen, recovery_secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(sessionToken, grupoUuid, usuario, deviceId, expiresAt, new Date().toISOString(), recoverySecretHash);

        await socket.join(grupoId);
        addSocketGroup(socket, grupoId);

        socket.emit('group_result', { success: true, grupo_id: grupoId, usuario, session_token: sessionToken, recovery_secret: recoverySecret, device_id: deviceId, admin_key: adminKey, is_private: isPrivate, is_admin: true, message: '✅ Grupo criado!' });
        scheduleUserCountUpdate(grupoId);
      } catch (err) {
        socket.emit('group_result', { success: false, msg: 'Erro interno.' });
      }
    });

    socket.on('join_group', async (data) => {
      if (!checkRateLimit(clientIp, 'join')) return socket.emit('group_result', { success: false, msg: 'Tente mais tarde.' });
      const grupoId = sanitizeInput(data?.grupo_id || '', 32);
      const nome = sanitizeInput(data?.usuario || '', 15);
      const password = (data?.password || '').trim();
      const auxDeviceId = (data?.device_id || '').trim();
      const session_token = data?.session_token || null;
      
      const groupInfo = db.prepare(`SELECT grupo_uuid, privado, senha_hash FROM grupos WHERE grupo_id = ?`).get(grupoId) as any;
      if (!groupInfo) {
        recordFailedAttempt(clientIp, 'join');
        return socket.emit('group_result', { success: false, msg: 'Grupo não encontrado' });
      }
      
      let validSession = session_token ? validateSession(session_token, grupoId, auxDeviceId) : null;
      let activeToken = session_token;

      cleanupInactiveSessions();

      const activeUserSession = db.prepare('SELECT device_id FROM sessoes WHERE grupo_uuid = ? AND LOWER(usuario) = LOWER(?)').get(groupInfo.grupo_uuid, nome) as any;
      if (activeUserSession && activeUserSession.device_id !== auxDeviceId) {
          recordFailedAttempt(clientIp, 'join');
          return socket.emit('group_result', { success: false, msg: 'Usuário já conectado em outro dispositivo.' });
      }

      let joinResult: any;
      if (!validSession || validSession.usuario.toLowerCase() !== nome.toLowerCase()) {
        if (groupInfo.privado) {
          const passwordHash = typeof groupInfo.senha_hash === 'string' ? groupInfo.senha_hash : null;
          if (!password || !passwordHash || !bcrypt.compareSync(password, passwordHash)) {
            recordFailedAttempt(clientIp, 'join');
            return socket.emit('group_result', { success: false, msg: 'Senha incorreta' });
          }
        }
        
        activeToken = crypto.randomBytes(32).toString('hex');
        const recoverySecret = crypto.randomBytes(16).toString('hex');
        db.prepare(`INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen, recovery_secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(activeToken, groupInfo.grupo_uuid, nome, auxDeviceId, new Date(Date.now() + INACTIVITY_TIMEOUT_MS).toISOString(), new Date().toISOString(), bcrypt.hashSync(recoverySecret, 10));
        
        joinResult = { success: true, grupo_id: grupoId, usuario: nome, session_token: activeToken, recovery_secret: recoverySecret, is_private: groupInfo.privado, is_admin: false, message: '✅ Conectado!' };
      } else {
        const group = db.prepare('SELECT admin_session_token FROM grupos WHERE grupo_uuid = ?').get(groupInfo.grupo_uuid) as any;
        joinResult = { success: true, grupo_id: grupoId, usuario: nome, session_token: activeToken, is_private: groupInfo.privado, is_admin: group.admin_session_token === activeToken, message: '✅ Conectado!' };
      }
      
      await socket.join(grupoId);
      addSocketGroup(socket, grupoId);
      socket.emit('group_result', joinResult);
      scheduleUserCountUpdate(grupoId);
    });

    socket.on('reclaim_admin', (data) => {
        const { grupo_id, session_token, device_id, admin_key } = data;
        const validSession = validateSession(session_token, grupo_id, device_id);
        if (!validSession) {
          recordFailedAttempt(clientIp, 'admin');
          return socket.emit('admin_result', { success: false, msg: 'Sessão inválida' });
        }
        
        const group = db.prepare('SELECT grupo_uuid, admin_key_hash FROM grupos WHERE grupo_id = ?').get(grupo_id) as any;
        if (!group || !admin_key || !bcrypt.compareSync(admin_key, group.admin_key_hash)) {
          recordFailedAttempt(clientIp, 'admin');
          return socket.emit('admin_result', { success: false, msg: 'Chave inválida' });
        }
        
        db.prepare('UPDATE grupos SET admin_session_token = ? WHERE grupo_uuid = ?').run(session_token, group.grupo_uuid);
        socket.emit('admin_result', { success: true, msg: 'Privilégios recuperados' });
    });

    socket.on('request_recovery', (data) => {
      if (!checkRateLimit(clientIp, 'recovery')) return socket.emit('recovery_result', { success: false, msg: 'Tente mais tarde.' });
      
      const { grupo_id: grupoId, usuario: nome, recovery_secret, device_id: auxDeviceId } = data;
      const group = db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`).get(grupoId) as any;
      if (!group) {
        recordFailedAttempt(clientIp, 'recovery');
        return socket.emit('recovery_result', { success: false, msg: 'Grupo não encontrado' });
      }
      
      const existingSession = db.prepare(`SELECT recovery_secret_hash, device_id FROM sessoes WHERE grupo_uuid = ? AND LOWER(usuario) = LOWER(?)`).get(group.grupo_uuid, nome) as any;
      const recoveryHash = typeof existingSession?.recovery_secret_hash === 'string' ? existingSession.recovery_secret_hash : null;
      if (!existingSession || !recovery_secret || !recoveryHash || !bcrypt.compareSync(recovery_secret, recoveryHash)) {
        recordFailedAttempt(clientIp, 'recovery');
        return socket.emit('recovery_result', { success: false, msg: 'Dados inválidos' });
      }
      if (!auxDeviceId || !existingSession.device_id || String(auxDeviceId) !== String(existingSession.device_id)) {
        recordFailedAttempt(clientIp, 'recovery');
        return socket.emit('recovery_result', { success: false, msg: 'Dispositivo inválido para esta recuperação' });
      }
      
      const token = crypto.randomBytes(16).toString('hex');
      temp_tokens[token] = { grupo_id: grupoId, usuario: nome, device_id: auxDeviceId, socket_id: socket.id, expires: new Date(Date.now() + 5 * 60 * 1000) };
      socket.emit('recovery_result', { success: true, token, msg: 'Token gerado' });
    });

    socket.on('verify_recovery', (data) => {
      const adminKey = typeof data.admin_key === 'string' ? data.admin_key.trim() : '';
      if (!checkRateLimit(clientIp, 'recovery') || (adminKey && !checkRateLimit(clientIp, 'admin'))) {
        return socket.emit('recovery_verified', { success: false, msg: 'Tente mais tarde.' });
      }
      const { token, grupo_id, usuario, device_id } = data;
      const tInfo = temp_tokens[token];
      if (!tInfo || tInfo.expires < new Date() || tInfo.grupo_id !== grupo_id || tInfo.usuario.toLowerCase() !== usuario.toLowerCase()) {
        recordFailedAttempt(clientIp, 'recovery');
        return socket.emit('recovery_verified', { success: false, msg: 'Token inválido' });
      }
      if (tInfo.socket_id && tInfo.socket_id !== socket.id) {
        recordFailedAttempt(clientIp, 'recovery');
        return socket.emit('recovery_verified', { success: false, msg: 'Token não associado à solicitação original' });
      }
      if (!device_id || !tInfo.device_id || String(device_id) !== String(tInfo.device_id)) {
        recordFailedAttempt(clientIp, 'recovery');
        return socket.emit('recovery_verified', { success: false, msg: 'Dispositivo inválido para este token' });
      }
      const group = db.prepare('SELECT grupo_uuid, admin_key_hash FROM grupos WHERE grupo_id = ?').get(grupo_id) as any;
      if (!group) {
        recordFailedAttempt(clientIp, 'recovery');
        return socket.emit('recovery_verified', { success: false, msg: 'Grupo não encontrado' });
      }
      const adminKeyHash = typeof group.admin_key_hash === 'string' ? group.admin_key_hash : null;
      if (adminKey && (!adminKeyHash || !bcrypt.compareSync(adminKey, adminKeyHash))) {
        recordFailedAttempt(clientIp, 'admin');
        return socket.emit('recovery_verified', { success: false, msg: 'Chave administrativa inválida' });
      }

      delete temp_tokens[token];
      
      db.prepare(`DELETE FROM sessoes WHERE grupo_uuid = ? AND LOWER(usuario) = LOWER(?)`).run(group.grupo_uuid, usuario);
      const sessionToken = crypto.randomBytes(32).toString('hex');
      const recoverySecret = crypto.randomBytes(16).toString('hex');
      db.prepare(`INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen, recovery_secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`) 
        .run(sessionToken, group.grupo_uuid, usuario, tInfo.device_id, new Date(Date.now() + INACTIVITY_TIMEOUT_MS).toISOString(), new Date().toISOString(), bcrypt.hashSync(recoverySecret, 10));
      if (adminKey) {
        db.prepare('UPDATE grupos SET admin_session_token = ? WHERE grupo_uuid = ?').run(sessionToken, group.grupo_uuid);
      }
        
      socket.emit('recovery_verified', {
        success: true,
        grupo_id: grupo_id,
        usuario: usuario,
        device_id: tInfo.device_id,
        session_token: sessionToken,
        recovery_secret: recoverySecret,
        is_admin: Boolean(adminKey),
        msg: 'Acesso recuperado!'
      });
    });

    socket.on('send_message', (data) => {
      const clientMsgId = typeof data?.client_msg_id === 'string' ? data.client_msg_id : '';
      const emitMessageResult = (success: boolean, msg: string, details: Record<string, unknown> = {}) => {
        socket.emit('message_result', { success, msg, client_msg_id: clientMsgId, ...details });
      };
      if (!consumeMessageRateLimit('ip', clientIp)) {
        return emitMessageResult(false, 'Limite de envio por IP excedido. Aguarde antes de tentar novamente.');
      }

      const grupoId = typeof data?.grupo_id === 'string' ? data.grupo_id : '';
      const sessionToken = typeof data?.session_token === 'string' ? data.session_token : '';
      const deviceId = typeof data?.device_id === 'string' ? data.device_id : '';
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(clientMsgId)) {
        return emitMessageResult(false, 'Identificador de mensagem inválido.');
      }
      if (typeof data?.msg !== 'string' || data.msg.length > 500) {
        return emitMessageResult(false, 'A mensagem deve ter no máximo 500 caracteres.');
      }

      const validSession = validateSession(sessionToken, grupoId, deviceId);
      if (!validSession) return emitMessageResult(false, 'Sessão inválida.');
      if (data.usuario != null && (typeof data.usuario !== 'string' || data.usuario.toLowerCase() !== validSession.usuario.toLowerCase())) {
        return emitMessageResult(false, 'Usuário inválido.');
      }

      const group = db.prepare('SELECT grupo_uuid FROM grupos WHERE grupo_id = ?').get(grupoId) as any;
      if (!group) return emitMessageResult(false, 'Grupo não encontrado.');

      const sanitized = sanitizeInput(data.msg, 500);
      if (!sanitized) return emitMessageResult(false, 'Mensagem vazia.');
      const existingMessage = db.prepare(`SELECT id, usuario, mensagem, data_hora FROM mensagens WHERE grupo_uuid = ? AND client_msg_id = ?`)
        .get(group.grupo_uuid, clientMsgId) as { id: number; usuario: string; mensagem: string; data_hora: string } | undefined;
      if (existingMessage) {
        if (existingMessage.usuario.toLowerCase() !== validSession.usuario.toLowerCase() || existingMessage.mensagem !== sanitized) {
          return emitMessageResult(false, 'Identificador de mensagem já utilizado.');
        }
        return emitMessageResult(true, 'Mensagem já registrada.', {
          duplicate: true,
          message_id: Number(existingMessage.id),
          message: { id: Number(existingMessage.id), user: existingMessage.usuario, msg: existingMessage.mensagem, time: existingMessage.data_hora }
        });
      }
      if (!consumeMessageRateLimit('session', sessionToken) || !consumeMessageRateLimit('room', group.grupo_uuid)) {
        return emitMessageResult(false, 'Limite de mensagens excedido. Aguarde antes de enviar novamente.');
      }

      const timestamp = new Date().toISOString();
      const inserted = db.prepare(`INSERT INTO mensagens (grupo_uuid, usuario, mensagem, data_hora, client_msg_id) VALUES (?, ?, ?, ?, ?)`).run(group.grupo_uuid, validSession.usuario, sanitized, timestamp, clientMsgId);
      io.to(grupoId).emit('receive_message', { id: Number(inserted.lastInsertRowid), grupo_id: grupoId, usuario: validSession.usuario, msg: sanitized, timestamp });
      emitMessageResult(true, 'Mensagem enviada.', {
        message_id: Number(inserted.lastInsertRowid),
        message: { id: Number(inserted.lastInsertRowid), user: validSession.usuario, msg: sanitized, time: timestamp }
      });
    });

    socket.on('load_history', (data) => {
      const grupoId = sanitizeInput(data?.grupo_id || '', 32);
      const sessionToken = data?.session_token;
      const deviceId = typeof data?.device_id === 'string' ? data.device_id.trim() : '';
      const validSession = sessionToken && deviceId ? validateSession(sessionToken, grupoId, deviceId) : null;
      if (!validSession) {
        return socket.emit('history_result', { success: false, grupo_id: grupoId, msg: 'Sessão inválida.' });
      }

      const group = db.prepare('SELECT grupo_uuid FROM grupos WHERE grupo_id = ?').get(grupoId) as { grupo_uuid: string } | undefined;
      if (!group) {
        return socket.emit('history_result', { success: false, grupo_id: grupoId, msg: 'Grupo não encontrado.' });
      }

      const requestedLimit = Number(data?.limit);
      const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 50) : 30;
      const beforeId = data?.before_id == null ? null : Number(data.before_id);
      if (beforeId !== null && (!Number.isSafeInteger(beforeId) || beforeId <= 0)) {
        return socket.emit('history_result', { success: false, grupo_id: grupoId, msg: 'Cursor inválido.' });
      }

      const rows = beforeId === null
        ? db.prepare(`SELECT id, usuario, mensagem, data_hora FROM mensagens WHERE grupo_uuid = ? ORDER BY id DESC LIMIT ?`).all(group.grupo_uuid, limit + 1) as any[]
        : db.prepare(`SELECT id, usuario, mensagem, data_hora FROM mensagens WHERE grupo_uuid = ? AND id < ? ORDER BY id DESC LIMIT ?`).all(group.grupo_uuid, beforeId, limit + 1) as any[];
      const hasMore = rows.length > limit;
      const messages = rows.slice(0, limit).reverse().map(row => ({
        id: Number(row.id),
        user: row.usuario,
        msg: row.mensagem,
        time: row.data_hora
      }));

      socket.emit('history_result', {
        success: true,
        grupo_id: grupoId,
        before_id: beforeId,
        next_before_id: messages[0]?.id ?? beforeId,
        has_more: hasMore,
        messages
      });
    });

    socket.on('leave_group', async (data) => {
      const validSession = validateSession(data.session_token, data.grupo_id, data.device_id);
      if (!validSession) return;
      
      await socket.leave(data.grupo_id);
      removeSocketGroup(socket, data.grupo_id);
      db.prepare(`DELETE FROM sessoes WHERE session_token = ?`).run(data.session_token);
      socket.emit('left_group', { success: true, grupo_id: data.grupo_id });
      scheduleUserCountUpdate(data.grupo_id);
    });

    socket.on('heartbeat', (data, acknowledge) => {
      const validSession = validateSession(data.session_token, data.grupo_id, data.device_id);
      if (typeof acknowledge === 'function') acknowledge(Boolean(validSession));
      if (validSession && typeof data?.grupo_id === 'string') scheduleUserCountUpdate(data.grupo_id);
    });

    socket.on('delete_group', async (data) => {
      if (!checkRateLimit(clientIp, 'admin')) return socket.emit('group_result', { success: false, msg: 'Tente mais tarde.' });
      
      const validSession = validateSession(data.session_token, data.grupo_id, data.device_id);
      if (!validSession) {
        recordFailedAttempt(clientIp, 'admin');
        return socket.emit('group_result', { success: false, msg: 'Sessão inválida.' });
      }

      const group = db.prepare(`SELECT grupo_uuid, admin_session_token FROM grupos WHERE grupo_id = ?`).get(data.grupo_id) as any;
      if (!group || group.admin_session_token !== data.session_token) {
        recordFailedAttempt(clientIp, 'admin');
        return socket.emit('group_result', { success: false, msg: 'Não autorizado.' });
      }
      
      db.prepare(`DELETE FROM grupos WHERE grupo_uuid = ?`).run(group.grupo_uuid);
      io.to(data.grupo_id).emit('group_deleted', { msg: 'Grupo excluído.' });
      await io.in(data.grupo_id).socketsLeave(data.grupo_id);
      removeSocketGroup(socket, data.grupo_id);
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), 'dist')));
    app.get('*', (_, res) => res.sendFile(path.join(process.cwd(), 'dist', 'index.html')));
  }

  httpServer.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🚀 Chat Grupal Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(console.error);
