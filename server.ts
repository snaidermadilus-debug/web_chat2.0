import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
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
  transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 3000;

// Database setup
const dbPath = path.join(process.cwd(), 'chat_database.db');
const db = new DatabaseSync(dbPath);

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
} catch (e: any) {
  console.error('❌ Database migration error:', e?.message || e);
}

const connected_users: Record<string, Record<string, [string, string, string]>> = {}; 
const temp_tokens: Record<string, { grupo_id: string; usuario: string; device_id: string; socket_id: string; expires: Date }> = {};
const failed_attempts: Record<string, [number, Date]> = {};
const INACTIVITY_TIMEOUT = 24 * 60; // 24 hours

function sanitizeInput(text: string, maxLength = 500): string {
  if (!text) return '';
  text = text.trim();
  if (text.length > maxLength) {
    text = text.substring(0, maxLength);
  }
  text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  text = text.replace(/[\x00-\x1F\x7F]/g, '');
  return text;
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
  if (!failed_attempts[key]) return true;
  const [count, lastAttempt] = failed_attempts[key];
  if (now.getTime() > lastAttempt.getTime() + 15 * 60 * 1000) {
    failed_attempts[key] = [0, now];
    return true;
  }
  let limit = operation === 'recovery' ? 3 : operation === 'admin' ? 5 : 10;
  return count < limit;
}

function validateSession(sessionToken: string, grupoId: string, auxiliaryDeviceId?: string): { usuario: string; device_id: string } | null {
  if (!sessionToken) return null;
  const stmt = db.prepare(`
    SELECT s.usuario, s.device_id 
    FROM sessoes s
    JOIN grupos g ON s.grupo_uuid = g.grupo_uuid
    WHERE s.session_token = ? AND g.grupo_id = ?
      AND s.expires_at > ?
  `);
  const nowIso = new Date().toISOString();
  const row = stmt.get(sessionToken, grupoId, nowIso) as { usuario: string; device_id: string } | undefined;
  
  if (row) {
    if (auxiliaryDeviceId && row.device_id && auxiliaryDeviceId !== row.device_id) return null;
    db.prepare(`UPDATE sessoes SET last_seen = ? WHERE session_token = ?`).run(nowIso, sessionToken);
    return row;
  }
  return null;
}

async function startServer() {
  io.on('connection', (socket) => {
    const clientIp = socket.handshake.address || '127.0.0.1';
    
    socket.on('disconnect', () => {
      for (const grupoId of Object.keys(connected_users)) {
        if (connected_users[grupoId][socket.id]) {
          socket.leave(grupoId);
          delete connected_users[grupoId][socket.id];
          const count = Object.keys(connected_users[grupoId] || {}).length;
          io.to(grupoId).emit('user_count_update', { grupo_id: grupoId, count });
          break;
        }
      }
    });

    socket.on('create_group', (data) => {
      if (!checkRateLimit(clientIp, 'create')) return socket.emit('group_result', { success: false, msg: 'Tente mais tarde.' });
      const grupoId = sanitizeInput(data?.grupo_id || '', 10);
      const usuario = sanitizeInput(data?.usuario || '', 15);
      const password = (data?.password || '').trim();
      const isPrivate = Boolean(data?.private);
      const deviceId = (data?.device_id || '').trim();

      if (!deviceId || !grupoId || !usuario) return socket.emit('group_result', { success: false, msg: 'Dados inválidos' });
      if (!/^[a-zA-Z0-9_-]{1,10}$/.test(grupoId)) return socket.emit('group_result', { success: false, msg: 'ID do grupo inválido' });
      
      try {
        if (db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`).get(grupoId)) return socket.emit('group_result', { success: false, msg: 'Grupo já existe' });
        const grupoUuid = crypto.randomUUID();
        const senhaHash = isPrivate && password ? bcrypt.hashSync(password, 10) : null;
        const nowIso = new Date().toISOString();
        const sessionToken = crypto.randomBytes(32).toString('hex');
        
        const adminKey = crypto.randomBytes(32).toString('hex');
        const adminKeyHash = bcrypt.hashSync(adminKey, 10);
        
        db.prepare(`INSERT INTO grupos (grupo_uuid, grupo_id, criado_em, criado_por, senha_hash, privado, admin_session_token, admin_key_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(grupoUuid, grupoId, nowIso, usuario, senhaHash, isPrivate ? 1 : 0, sessionToken, adminKeyHash);

        // 128 bit entropy (16 bytes)
        const recoverySecret = crypto.randomBytes(16).toString('hex');
        const recoverySecretHash = bcrypt.hashSync(recoverySecret, 10);
        const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        db.prepare(`INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen, recovery_secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(sessionToken, grupoUuid, usuario, deviceId, expiresAt, nowIso, recoverySecretHash);

        socket.join(grupoId);
        if (!connected_users[grupoId]) connected_users[grupoId] = {};
        connected_users[grupoId][socket.id] = [usuario, sessionToken, deviceId];

        socket.emit('group_result', { success: true, grupo_id: grupoId, usuario, session_token: sessionToken, recovery_secret: recoverySecret, device_id: deviceId, admin_key: adminKey, is_private: isPrivate, is_admin: true, message: '✅ Grupo criado!' });
      } catch (err) {
        socket.emit('group_result', { success: false, msg: 'Erro interno.' });
      }
    });

    socket.on('join_group', (data) => {
      if (!checkRateLimit(clientIp, 'join')) return socket.emit('group_result', { success: false, msg: 'Tente mais tarde.' });
      const { grupo_id: grupoId, usuario: nome, password, session_token, device_id: auxDeviceId } = data;
      
      const groupInfo = db.prepare(`SELECT grupo_uuid, privado, senha_hash, admin_session_token FROM grupos WHERE grupo_id = ?`).get(grupoId) as any;
      if (!groupInfo) return socket.emit('group_result', { success: false, msg: 'Grupo não encontrado' });
      
      let validSession = session_token ? validateSession(session_token, grupoId, auxDeviceId) : null;
      let activeToken = session_token;
      
      if (!validSession || validSession.usuario.toLowerCase() !== nome.toLowerCase()) {
        if (groupInfo.privado && (!password || !bcrypt.compareSync(password, groupInfo.senha_hash))) return socket.emit('group_result', { success: false, msg: 'Senha incorreta' });
        
        activeToken = crypto.randomBytes(32).toString('hex');
        const recoverySecret = crypto.randomBytes(16).toString('hex');
        db.prepare(`INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen, recovery_secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(activeToken, groupInfo.grupo_uuid, nome, auxDeviceId, new Date(Date.now() + 24 * 3600 * 1000).toISOString(), new Date().toISOString(), bcrypt.hashSync(recoverySecret, 10));
        
        socket.emit('group_result', { success: true, grupo_id: grupoId, usuario: nome, session_token: activeToken, recovery_secret: recoverySecret, is_private: groupInfo.privado, is_admin: false, message: '✅ Conectado!' });
      } else {
        socket.emit('group_result', { success: true, grupo_id: grupoId, usuario: nome, session_token: activeToken, is_private: groupInfo.privado, is_admin: groupInfo.admin_session_token === activeToken, message: '✅ Conectado!' });
      }
      
      socket.join(grupoId);
      connected_users[grupoId] = { ...connected_users[grupoId], [socket.id]: [nome, activeToken, auxDeviceId] };
      io.to(grupoId).emit('user_count_update', { grupo_id: grupoId, count: Object.keys(connected_users[grupoId]).length });
    });

    socket.on('reclaim_admin', (data) => {
        const { grupo_id, session_token, device_id, admin_key } = data;
        const validSession = validateSession(session_token, grupo_id, device_id);
        if (!validSession) return socket.emit('admin_result', { success: false, msg: 'Sessão inválida' });
        
        const group = db.prepare('SELECT grupo_uuid, admin_key_hash FROM grupos WHERE grupo_id = ?').get(grupo_id) as any;
        if (!group || !admin_key || !bcrypt.compareSync(admin_key, group.admin_key_hash)) return socket.emit('admin_result', { success: false, msg: 'Chave inválida' });
        
        db.prepare('UPDATE grupos SET admin_session_token = ? WHERE grupo_uuid = ?').run(session_token, group.grupo_uuid);
        socket.emit('admin_result', { success: true, msg: 'Privilégios recuperados' });
    });

    socket.on('send_message', (data) => {
      const validSession = validateSession(data.session_token, data.grupo_id, data.device_id);
      if (!validSession) return;
      
      const group = db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`).get(data.grupo_id) as any;
      if (!group) return;

      const sanitized = sanitizeInput(data.msg, 500);
      db.prepare(`INSERT INTO mensagens (grupo_uuid, usuario, mensagem, data_hora) VALUES (?, ?, ?, ?)`).run(group.grupo_uuid, validSession.usuario, sanitized, new Date().toISOString());
      io.to(data.grupo_id).emit('receive_message', { grupo_id: data.grupo_id, usuario: validSession.usuario, msg: sanitized, timestamp: new Date().toISOString() });
    });

    socket.on('leave_group', (data) => {
      const validSession = validateSession(data.session_token, data.grupo_id, data.device_id);
      if (!validSession) return;
      
      socket.leave(data.grupo_id);
      if (connected_users[data.grupo_id]) {
          delete connected_users[data.grupo_id][socket.id];
          io.to(data.grupo_id).emit('user_count_update', { grupo_id: data.grupo_id, count: Object.keys(connected_users[data.grupo_id]).length });
      }
      db.prepare(`DELETE FROM sessoes WHERE session_token = ?`).run(data.session_token);
      socket.emit('left_group', { success: true, grupo_id: data.grupo_id });
    });

    socket.on('heartbeat', (data) => {
      const validSession = validateSession(data.session_token, data.grupo_id, data.device_id);
      if (validSession) {
          db.prepare(`UPDATE sessoes SET last_seen = ? WHERE session_token = ?`).run(new Date().toISOString(), data.session_token);
      }
    });

    socket.on('delete_group', async (data) => {
      if (!checkRateLimit(clientIp, 'admin')) return socket.emit('group_result', { success: false, msg: 'Tente mais tarde.' });
      
      const group = db.prepare(`SELECT grupo_uuid, admin_session_token FROM grupos WHERE grupo_id = ?`).get(data.grupo_id) as any;
      if (!group || group.admin_session_token !== data.session_token) return socket.emit('group_result', { success: false, msg: 'Não autorizado.' });
      
      db.prepare(`DELETE FROM grupos WHERE grupo_uuid = ?`).run(group.grupo_uuid);
      io.to(data.grupo_id).emit('group_deleted', { msg: 'Grupo excluído.' });
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
