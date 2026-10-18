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
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigin 
      ? (allowedOrigin.includes(',') ? allowedOrigin.split(',').map(s => s.trim()) : allowedOrigin)
      : true,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 3000;

// Database setup
const dbPath = path.join(process.cwd(), 'chat_database.db');
const db = new DatabaseSync(dbPath);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS grupos (
    grupo_uuid TEXT PRIMARY KEY,
    grupo_id TEXT UNIQUE NOT NULL,
    criado_em TEXT NOT NULL,
    criado_por TEXT NOT NULL,
    senha_hash TEXT,
    privado BOOLEAN DEFAULT 0,
    admin_session_token TEXT,
    admin_key TEXT
  );
`);

// Migration: Check specifically if columns exist before adding them, and log unexpected migration errors
try {
  const tableInfo = db.prepare('PRAGMA table_info(grupos)').all() as { cid: number; name: string; type: string }[];
  const existingColumns = new Set(tableInfo.map(col => col.name));

  if (!existingColumns.has('admin_session_token')) {
    db.exec('ALTER TABLE grupos ADD COLUMN admin_session_token TEXT');
    console.log('✅ Migrated grupos: added admin_session_token column');
  }

  if (!existingColumns.has('admin_key')) {
    db.exec('ALTER TABLE grupos ADD COLUMN admin_key TEXT');
    console.log('✅ Migrated grupos: added admin_key column');
  }

  // Populate admin_key for existing groups that might not have one
  const groupsWithoutKey = db.prepare(`SELECT grupo_uuid FROM grupos WHERE admin_key IS NULL`).all() as any[];
  for (const g of groupsWithoutKey) {
    const key = crypto.randomBytes(32).toString('hex');
    db.prepare(`UPDATE grupos SET admin_key = ? WHERE grupo_uuid = ?`).run(key, g.grupo_uuid);
  }

  if (existingColumns.has('admin_device_id')) {
    try {
      db.exec('ALTER TABLE grupos DROP COLUMN admin_device_id');
      console.log('✅ Migrated grupos: dropped obsolete admin_device_id column');
    } catch (dropErr: any) {
      console.warn('⚠️ SQLite note: could not drop column admin_device_id (supported in SQLite 3.35+):', dropErr?.message);
    }
  }
} catch (e: any) {
  console.error('❌ Database migration error:', e?.message || e);
  process.exit(1);
}

db.exec(`
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
    last_seen TEXT NOT NULL
  );
`);

console.log('✅ SQLite Database initialized at:', dbPath);

// In-memory state
const connected_users: Record<string, Record<string, [string, string, string]>> = {}; 
const temp_tokens: Record<string, { grupo_id: string; usuario: string; device_id: string; expires: Date }> = {};
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

function recordFailedAttempt(ip: string) {
  const now = new Date();
  if (!failed_attempts[ip]) {
    failed_attempts[ip] = [1, now];
  } else {
    failed_attempts[ip][0] += 1;
  }
}

function checkRateLimit(ip: string): boolean {
  const now = new Date();
  if (!failed_attempts[ip]) return true;
  const [count, resetTime] = failed_attempts[ip];
  if (now.getTime() > resetTime.getTime() + 15 * 60 * 1000) {
    failed_attempts[ip] = [0, now];
    return true;
  }
  return count < 10;
}

function validateSession(sessionToken: string, grupoId: string, auxiliaryDeviceId?: string): string | null {
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
    if (auxiliaryDeviceId && auxiliaryDeviceId !== row.device_id) {
      db.prepare(`UPDATE sessoes SET last_seen = ?, device_id = ? WHERE session_token = ?`)
        .run(nowIso, auxiliaryDeviceId, sessionToken);
    } else {
      db.prepare(`UPDATE sessoes SET last_seen = ? WHERE session_token = ?`)
        .run(nowIso, sessionToken);
    }
    return row.usuario;
  }
  return null;
}

function isUsernameTaken(grupoUuid: string, usuario: string, activeSessionToken?: string): boolean {
  const nowIso = new Date().toISOString();
  if (activeSessionToken) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM sessoes 
      WHERE grupo_uuid = ? AND LOWER(usuario) = LOWER(?) AND session_token != ? 
        AND expires_at > ?
    `);
    const row = stmt.get(grupoUuid, usuario, activeSessionToken, nowIso) as { count: number } | undefined;
    return (row?.count || 0) > 0;
  } else {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM sessoes 
      WHERE grupo_uuid = ? AND LOWER(usuario) = LOWER(?)
        AND expires_at > ?
    `);
    const row = stmt.get(grupoUuid, usuario, nowIso) as { count: number } | undefined;
    return (row?.count || 0) > 0;
  }
}

// Cleanup inactive sessions periodically
setInterval(() => {
  try {
    const timeoutIso = new Date(Date.now() - INACTIVITY_TIMEOUT * 60 * 1000).toISOString();
    const stmt = db.prepare(`DELETE FROM sessoes WHERE last_seen < ?`);
    const result = stmt.run(timeoutIso);
    if (result.changes > 0) {
      console.log(`🧹 Removed ${result.changes} inactive sessions`);
    }
  } catch (err) {
    console.error('Error cleaning inactive users:', err);
  }
}, 60 * 1000);

async function startServer() {
  io.on('connection', (socket) => {
    const clientIp = socket.handshake.address || '127.0.0.1';
    
    socket.on('disconnect', () => {
      for (const grupoId of Object.keys(connected_users)) {
        if (connected_users[grupoId][socket.id]) {
          socket.leave(grupoId);
          delete connected_users[grupoId][socket.id];
          if (Object.keys(connected_users[grupoId]).length === 0) delete connected_users[grupoId];
          const count = Object.keys(connected_users[grupoId] || {}).length;
          io.to(grupoId).emit('user_count_update', { grupo_id: grupoId, count });
          break;
        }
      }
    });

    socket.on('create_group', (data) => {
      if (!checkRateLimit(clientIp)) {
        socket.emit('group_result', { success: false, msg: 'Muitas tentativas. Aguarde 15 minutos.' });
        return;
      }
      const grupoId = sanitizeInput(data?.grupo_id || '', 10);
      const usuario = sanitizeInput(data?.usuario || '', 15);
      const password = (data?.password || '').trim();
      const isPrivate = Boolean(data?.private);
      const deviceId = (data?.device_id || '').trim();

      if (!deviceId || !grupoId || !usuario) {
        socket.emit('group_result', { success: false, msg: 'Dados inválidos' });
        return;
      }

      if (!/^[a-zA-Z0-9_-]{1,10}$/.test(grupoId)) {
        recordFailedAttempt(clientIp);
        socket.emit('group_result', { success: false, msg: 'ID do grupo inválido' });
        return;
      }

      if (isPrivate && (!password || password.length < 4)) {
        recordFailedAttempt(clientIp);
        socket.emit('group_result', { success: false, msg: 'Senha necessária (mín. 4 caracteres).' });
        return;
      }

      try {
        if (db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`).get(grupoId)) {
          recordFailedAttempt(clientIp);
          socket.emit('group_result', { success: false, msg: 'Grupo já existe' });
          return;
        }
        const grupoUuid = crypto.randomUUID();
        const senhaHash = isPrivate && password ? bcrypt.hashSync(password, 10) : null;
        const nowIso = new Date().toISOString();
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const adminKey = crypto.randomBytes(32).toString('hex');
        
        db.prepare(`
          INSERT INTO grupos (grupo_uuid, grupo_id, criado_em, criado_por, senha_hash, privado, admin_session_token, admin_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(grupoUuid, grupoId, nowIso, usuario, senhaHash, isPrivate ? 1 : 0, sessionToken, adminKey);

        const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        db.prepare(`
          INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(sessionToken, grupoUuid, usuario, deviceId, expiresAt, nowIso);

        socket.join(grupoId);
        if (!connected_users[grupoId]) connected_users[grupoId] = {};
        connected_users[grupoId][socket.id] = [usuario, sessionToken, deviceId];

        socket.emit('group_result', {
          success: true,
          grupo_id: grupoId,
          usuario,
          session_token: sessionToken,
          device_id: deviceId,
          admin_key: adminKey,
          historico: [],
          user_count: 1,
          is_private: isPrivate,
          is_admin: true,
          message: '✅ Grupo criado com sucesso!'
        });
        io.to(grupoId).emit('user_count_update', { grupo_id: grupoId, count: 1 });
      } catch (err) {
        socket.emit('group_result', { success: false, msg: 'Erro interno ao criar grupo.' });
      }
    });

    socket.on('join_group', (data) => {
      if (!checkRateLimit(clientIp)) {
        socket.emit('group_result', { success: false, msg: 'Muitas tentativas. Aguarde 15 minutos.' });
        return;
      }

      const grupoId = sanitizeInput(data?.grupo_id || '', 10);
      const usuario = sanitizeInput(data?.usuario || '', 15);
      const password = (data?.password || '').trim();
      const sessionToken = (data?.session_token || '').trim();
      const auxiliaryDeviceId = (data?.device_id || '').trim();

      if (!grupoId || !usuario) {
        recordFailedAttempt(clientIp);
        socket.emit('group_result', { success: false, msg: 'Dados incompletos' });
        return;
      }

      try {
        const groupInfo = db.prepare(`SELECT grupo_uuid, privado, senha_hash, admin_session_token, admin_key FROM grupos WHERE grupo_id = ?`).get(grupoId) as any;
        if (!groupInfo) {
          recordFailedAttempt(clientIp);
          socket.emit('group_result', { success: false, msg: 'Grupo não encontrado' });
          return;
        }

        const { grupo_uuid, privado, senha_hash, admin_session_token, admin_key } = groupInfo;
        const providedAdminKey = (data?.admin_key || '').trim();

        // Check if client presents a valid, unexpired session token for this group
        let activeToken = sessionToken;
        let validUsuario = sessionToken ? validateSession(sessionToken, grupoId, auxiliaryDeviceId) : null;
        const isRestoringValidSession = Boolean(validUsuario && validUsuario.toLowerCase() === usuario.toLowerCase());

        if (!isRestoringValidSession) {
          // New connection attempting to take this username: verify username is not already claimed
          if (isUsernameTaken(grupo_uuid, usuario)) {
            recordFailedAttempt(clientIp);
            socket.emit('group_result', { success: false, msg: 'Nome já em uso no grupo.' });
            return;
          }

          if (connected_users[grupoId]) {
            for (const [, [uName, sToken]] of Object.entries(connected_users[grupoId])) {
              if (uName.toLowerCase() === usuario.toLowerCase() && sToken !== activeToken) {
                recordFailedAttempt(clientIp);
                socket.emit('group_result', { success: false, msg: 'Nome já em uso por outro participante conectado.' });
                return;
              }
            }
          }

          if (privado && (!senha_hash || !bcrypt.compareSync(password, senha_hash))) {
            recordFailedAttempt(clientIp);
            socket.emit('group_result', { success: false, msg: 'Senha incorreta ou necessária' });
            return;
          }

          // Clean previous sessions and issue a new unpredictable, server-generated session token
          db.prepare(`DELETE FROM sessoes WHERE grupo_uuid = ? AND LOWER(usuario) = LOWER(?)`).run(grupo_uuid, usuario);
          activeToken = crypto.randomBytes(32).toString('hex');
          const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
          db.prepare(`INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(activeToken, grupo_uuid, usuario, auxiliaryDeviceId, expiresAt, new Date().toISOString());
        }

        let isAdmin = false;
        if (providedAdminKey && admin_key && providedAdminKey === admin_key) {
          db.prepare(`UPDATE grupos SET admin_session_token = ? WHERE grupo_uuid = ?`).run(activeToken, grupo_uuid);
          isAdmin = true;
        } else if (admin_session_token && admin_session_token === activeToken) {
          isAdmin = true;
        }

        const historico = db.prepare(`SELECT usuario, mensagem, data_hora FROM mensagens WHERE grupo_uuid = ? ORDER BY id DESC LIMIT 100`).all(grupo_uuid).reverse();

        // Disconnect previous socket for this authenticated session/user
        for (const [sId, [uName, sToken]] of Object.entries(connected_users[grupoId] || {})) {
          if (sToken === activeToken || (uName.toLowerCase() === usuario.toLowerCase() && isRestoringValidSession)) {
             const oldSocket = io.sockets.sockets.get(sId);
             if (oldSocket) { oldSocket.leave(grupoId); oldSocket.disconnect(true); }
             delete connected_users[grupoId][sId];
          }
        }
        if (!connected_users[grupoId]) connected_users[grupoId] = {};
        
        socket.join(grupoId);
        connected_users[grupoId][socket.id] = [usuario, activeToken, auxiliaryDeviceId];
        const currentCount = Object.keys(connected_users[grupoId]).length;
        
        socket.emit('group_result', {
          success: true,
          grupo_id: grupoId,
          usuario,
          session_token: activeToken,
          device_id: auxiliaryDeviceId,
          admin_key: isAdmin ? admin_key : undefined,
          historico: historico.map((r: any) => ({ user: r.usuario, msg: r.mensagem, time: r.data_hora })),
          user_count: currentCount,
          is_private: Boolean(privado),
          is_admin: isAdmin,
          message: '✅ Conectado ao grupo!'
        });
        io.to(grupoId).emit('user_count_update', { grupo_id: grupoId, count: currentCount });
      } catch (err) {
        socket.emit('group_result', { success: false, msg: 'Erro interno ao entrar no grupo.' });
      }
    });

    socket.on('send_message', (data) => {
      const { grupo_id, session_token, device_id, msg } = data;
      const validUsuario = validateSession(session_token, grupo_id, device_id);
      if (!validUsuario) return;
      
      const group = db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`).get(grupo_id) as any;
      if (!group) return;

      const sanitized = sanitizeInput(msg, 500);
      const time = new Date().toISOString();
      db.prepare(`INSERT INTO mensagens (grupo_uuid, usuario, mensagem, data_hora) VALUES (?, ?, ?, ?)`).run(group.grupo_uuid, validUsuario, sanitized, time);
      io.to(grupo_id).emit('receive_message', { grupo_id, usuario: validUsuario, msg: sanitized, timestamp: time });
    });

    socket.on('leave_group', (data) => {
      const { grupo_id, session_token, device_id } = data;
      if (grupo_id) {
        socket.leave(grupo_id);
        if (connected_users[grupo_id] && connected_users[grupo_id][socket.id]) {
          delete connected_users[grupo_id][socket.id];
          if (Object.keys(connected_users[grupo_id]).length === 0) delete connected_users[grupo_id];
          const count = Object.keys(connected_users[grupo_id] || {}).length;
          io.to(grupo_id).emit('user_count_update', { grupo_id: grupo_id, count });
        }
      }
      if (session_token) {
        db.prepare(`DELETE FROM sessoes WHERE session_token = ?`).run(session_token);
      }
      socket.emit('left_group', { success: true, grupo_id, message: '✅ Você saiu do grupo' });
    });

    socket.on('heartbeat', (data) => {
      const { session_token, device_id } = data;
      if (session_token) {
        const nowIso = new Date().toISOString();
        if (device_id) {
          db.prepare(`UPDATE sessoes SET last_seen = ?, device_id = ? WHERE session_token = ?`)
            .run(nowIso, device_id, session_token);
        } else {
          db.prepare(`UPDATE sessoes SET last_seen = ? WHERE session_token = ?`)
            .run(nowIso, session_token);
        }
      }
    });

    socket.on('request_recovery', (data) => {
      if (!checkRateLimit(clientIp)) {
        socket.emit('recovery_result', { success: false, msg: 'Muitas tentativas. Aguarde 15 minutos.' });
        return;
      }
      const grupoId = sanitizeInput(data?.grupo_id || '', 10);
      const usuario = sanitizeInput(data?.usuario || '', 15);
      const password = (data?.password || '').trim();
      const adminKey = (data?.admin_key || '').trim();
      const auxiliaryDeviceId = (data?.device_id || '').trim();

      if (!grupoId || !usuario) {
        recordFailedAttempt(clientIp);
        socket.emit('recovery_result', { success: false, msg: 'Dados inválidos' });
        return;
      }

      const group = db.prepare(`SELECT grupo_uuid, privado, senha_hash, admin_key FROM grupos WHERE grupo_id = ?`).get(grupoId) as any;
      if (!group) {
        recordFailedAttempt(clientIp);
        socket.emit('recovery_result', { success: false, msg: 'Grupo não encontrado' });
        return;
      }

      // If group is private, verify room password or admin key
      if (group.privado) {
        const isPasswordValid = group.senha_hash && password && bcrypt.compareSync(password, group.senha_hash);
        const isAdminKeyValid = group.admin_key && adminKey && adminKey === group.admin_key;
        if (!isPasswordValid && !isAdminKeyValid) {
          recordFailedAttempt(clientIp);
          socket.emit('recovery_result', { success: false, msg: 'Senha necessária para recuperação em sala privada.' });
          return;
        }
      }

      const token = crypto.randomBytes(3).toString('hex');
      temp_tokens[token] = { 
        grupo_id: grupoId, 
        usuario, 
        device_id: auxiliaryDeviceId, 
        expires: new Date(Date.now() + 5 * 60 * 1000) 
      };
      socket.emit('recovery_result', { success: true, token, msg: 'Token gerado' });
    });

    socket.on('verify_recovery', (data) => {
      if (!checkRateLimit(clientIp)) {
        socket.emit('recovery_verified', { success: false, msg: 'Muitas tentativas. Aguarde 15 minutos.' });
        return;
      }
      const { token, grupo_id, usuario } = data;
      const auxiliaryDeviceId = (data?.device_id || '').trim();
      const providedAdminKey = (data?.admin_key || '').trim();
      const tInfo = temp_tokens[token];
      if (!tInfo || tInfo.expires.getTime() < Date.now() || tInfo.grupo_id !== grupo_id || tInfo.usuario.toLowerCase() !== usuario.toLowerCase()) {
        recordFailedAttempt(clientIp);
        socket.emit('recovery_verified', { success: false, msg: 'Token inválido ou expirado' });
        return;
      }
      
      const group = db.prepare(`SELECT grupo_uuid, admin_key, admin_session_token FROM grupos WHERE grupo_id = ?`).get(grupo_id) as any;
      if (!group) {
        recordFailedAttempt(clientIp);
        socket.emit('recovery_verified', { success: false, msg: 'Grupo não encontrado' });
        return;
      }

      // Clear previous sessions for this user in this group
      db.prepare(`DELETE FROM sessoes WHERE grupo_uuid = ? AND LOWER(usuario) = LOWER(?)`).run(group.grupo_uuid, usuario);
      
      const sessionToken = crypto.randomBytes(32).toString('hex');
      db.prepare(`INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(sessionToken, group.grupo_uuid, usuario, auxiliaryDeviceId, new Date(Date.now() + 24 * 3600 * 1000).toISOString(), new Date().toISOString());

      // Independent admin credential verification: Never promote by display name or device ID!
      let isRecoveredAdmin = false;
      if (providedAdminKey && group.admin_key && providedAdminKey === group.admin_key) {
        db.prepare(`UPDATE grupos SET admin_session_token = ? WHERE grupo_uuid = ?`).run(sessionToken, group.grupo_uuid);
        isRecoveredAdmin = true;
      }
      
      delete temp_tokens[token];
      socket.emit('recovery_verified', {
        success: true,
        session_token: sessionToken,
        grupo_id,
        usuario,
        device_id: auxiliaryDeviceId,
        is_admin: isRecoveredAdmin,
        admin_key: isRecoveredAdmin ? group.admin_key : undefined,
        msg: isRecoveredAdmin ? 'Acesso e privilégios de administrador recuperados!' : 'Acesso recuperado!'
      });
    });

    socket.on('delete_group', async (data) => {
      if (!checkRateLimit(clientIp)) {
        socket.emit('group_result', { success: false, msg: 'Muitas tentativas. Aguarde 15 minutos.' });
        return;
      }
      const grupoId = sanitizeInput(data?.grupo_id || '', 10);
      const sessionToken = (data?.session_token || '').trim();
      const adminKey = (data?.admin_key || '').trim();

      if (!grupoId || !sessionToken) {
        recordFailedAttempt(clientIp);
        socket.emit('group_result', { success: false, msg: 'Dados incompletos.' });
        return;
      }

      const nowIso = new Date().toISOString();
      const group = db.prepare(`SELECT grupo_uuid, admin_session_token, admin_key FROM grupos WHERE grupo_id = ?`).get(grupoId) as any;
      if (!group) {
        recordFailedAttempt(clientIp);
        socket.emit('group_result', { success: false, msg: 'Grupo não encontrado.' });
        return;
      }

      // Validate session in database: must be active and unexpired based on unpredictable session token
      const activeSession = db.prepare(`
        SELECT usuario, expires_at 
        FROM sessoes 
        WHERE session_token = ? AND grupo_uuid = ? AND expires_at > ?
      `).get(sessionToken, group.grupo_uuid, nowIso) as any;

      if (!activeSession) {
        recordFailedAttempt(clientIp);
        socket.emit('group_result', { success: false, msg: 'Sessão administrativa expirada ou inválida.' });
        return;
      }

      // Administrative authorization is strictly tied to validated admin credentials, NOT display name or device ID
      const isAuthorizedAdmin = Boolean(
        (group.admin_session_token && group.admin_session_token === sessionToken) ||
        (adminKey && group.admin_key && adminKey === group.admin_key)
      );

      if (!isAuthorizedAdmin) {
        recordFailedAttempt(clientIp);
        socket.emit('group_result', { success: false, msg: 'Não autorizado.' });
        return;
      }

      db.prepare(`DELETE FROM grupos WHERE grupo_uuid = ?`).run(group.grupo_uuid);
      db.prepare(`DELETE FROM sessoes WHERE grupo_uuid = ?`).run(group.grupo_uuid);
      db.prepare(`DELETE FROM mensagens WHERE grupo_uuid = ?`).run(group.grupo_uuid);

      // Notify clients in the room before tearing down subscriptions
      io.to(grupoId).emit('group_deleted', { msg: 'Grupo excluído pelo administrador.' });

      // Explicitly remove all connected sockets from the Socket.IO room and clear state
      try {
        const roomSockets = await io.in(grupoId).fetchSockets();
        for (const s of roomSockets) {
          s.leave(grupoId);
        }
        io.socketsLeave(grupoId);
      } catch (leaveErr) {
        console.warn('Warning when removing sockets from room:', leaveErr);
      }

      if (connected_users[grupoId]) {
        delete connected_users[grupoId];
      }
    });
  });

  // Setup Vite development middleware or static serving
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
