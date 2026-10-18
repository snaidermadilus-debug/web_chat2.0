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
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 3000;

// Database setup
const dbDir = path.join(process.env.HOME || '.', '.cache', '.chatdata');
fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, '.x9a_final.db');

const db = new DatabaseSync(dbPath);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS grupos (
    grupo_uuid TEXT PRIMARY KEY,
    grupo_id TEXT UNIQUE NOT NULL,
    criado_em TEXT NOT NULL,
    criado_por TEXT NOT NULL,
    senha_hash TEXT,
    privado BOOLEAN DEFAULT 0
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
    last_seen TEXT NOT NULL
  );
`);

console.log('✅ SQLite Database initialized at:', dbPath);

// In-memory state
const connected_users: Record<string, Record<string, [string, string, string]>> = {}; // {grupo_id: {sid: (usuario, session_token, device_id)}}
const temp_tokens: Record<string, { grupo_id: string; usuario: string; device_id: string; expires: Date }> = {};
const failed_attempts: Record<string, [number, Date]> = {};
const INACTIVITY_TIMEOUT = 10; // minutes

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

function checkRateLimit(ip: string): boolean {
  const now = new Date();
  if (!failed_attempts[ip]) {
    failed_attempts[ip] = [0, now];
  }
  const [count, resetTime] = failed_attempts[ip];
  if (now.getTime() > resetTime.getTime() + 15 * 60 * 1000) {
    failed_attempts[ip] = [0, now];
    return true;
  }
  if (count >= 10) {
    return false;
  }
  return true;
}

function validateSession(sessionToken: string, grupoId: string, deviceId: string): string | null {
  const stmt = db.prepare(`
    SELECT s.usuario 
    FROM sessoes s
    JOIN grupos g ON s.grupo_uuid = g.grupo_uuid
    WHERE s.session_token = ? AND g.grupo_id = ? AND s.device_id = ?
      AND s.expires_at > ?
  `);
  const nowIso = new Date().toISOString();
  const row = stmt.get(sessionToken, grupoId, deviceId) as { usuario: string } | undefined;

  if (row) {
    const updateStmt = db.prepare(`UPDATE sessoes SET last_seen = ? WHERE session_token = ?`);
    updateStmt.run(nowIso, sessionToken);
    return row.usuario;
  }
  return null;
}

function isUsernameTakenByOtherDevice(grupoUuid: string, usuario: string, deviceId: string): boolean {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM sessoes 
    WHERE grupo_uuid = ? AND usuario = ? AND device_id != ? 
      AND expires_at > ?
  `);
  const nowIso = new Date().toISOString();
  const row = stmt.get(grupoUuid, usuario, deviceId, nowIso) as { count: number } | undefined;
  return (row?.count || 0) > 0;
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

// Socket.io handlers
io.on('connection', (socket) => {
  const clientIp = socket.handshake.address || '127.0.0.1';
  console.log(`✅ Client connected: ${socket.id} (${clientIp})`);

  socket.on('disconnect', () => {
    for (const grupoId of Object.keys(connected_users)) {
      if (connected_users[grupoId][socket.id]) {
        socket.leave(grupoId);
        delete connected_users[grupoId][socket.id];
        if (Object.keys(connected_users[grupoId]).length === 0) {
          delete connected_users[grupoId];
        }
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

    if (!deviceId) {
      socket.emit('group_result', { success: false, msg: 'Device ID necessário' });
      return;
    }

    if (!grupoId || !usuario) {
      socket.emit('group_result', { success: false, msg: 'Dados inválidos' });
      return;
    }

    if (!/^[a-zA-Z0-9_-]{1,10}$/.test(grupoId)) {
      socket.emit('group_result', { success: false, msg: 'ID do grupo inválido (máx 10 chars, sem espaços)' });
      return;
    }

    try {
      const checkStmt = db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`);
      if (checkStmt.get(grupoId)) {
        socket.emit('group_result', { success: false, msg: 'Grupo já existe' });
        return;
      }

      const grupoUuid = crypto.randomUUID();
      const senhaHash = isPrivate && password ? bcrypt.hashSync(password, 10) : null;
      const nowIso = new Date().toISOString();

      const insertGroup = db.prepare(`
        INSERT INTO grupos (grupo_uuid, grupo_id, criado_em, criado_por, senha_hash, privado)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertGroup.run(grupoUuid, grupoId, nowIso, usuario, senhaHash, isPrivate ? 1 : 0);

      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

      const insertSession = db.prepare(`
        INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertSession.run(sessionToken, grupoUuid, usuario, deviceId, expiresAt, nowIso);

      socket.join(grupoId);
      if (!connected_users[grupoId]) connected_users[grupoId] = {};
      connected_users[grupoId][socket.id] = [usuario, sessionToken, deviceId];

      socket.emit('group_result', {
        success: true,
        grupo_id: grupoId,
        usuario,
        session_token: sessionToken,
        device_id: deviceId,
        historico: [],
        user_count: 1,
        is_private: isPrivate,
        is_admin: true,
        message: '✅ Grupo criado com sucesso!'
      });

      io.to(grupoId).emit('user_count_update', { grupo_id: grupoId, count: 1 });
    } catch (err: any) {
      console.error('Error creating group:', err);
      socket.emit('group_result', { success: false, msg: 'Erro ao criar grupo: ' + err.message });
    }
  });

  socket.on('join_group', (data) => {
    const grupoId = sanitizeInput(data?.grupo_id || '', 10);
    const usuario = sanitizeInput(data?.usuario || '', 15);
    const password = (data?.password || '').trim();
    const sessionToken = (data?.session_token || '').trim();
    const deviceId = (data?.device_id || '').trim();

    if (!deviceId || !grupoId || !usuario) {
      socket.emit('group_result', { success: false, msg: 'Dados incompletos' });
      return;
    }

    try {
      const groupStmt = db.prepare(`SELECT grupo_uuid, privado, senha_hash FROM grupos WHERE grupo_id = ?`);
      const groupInfo = groupStmt.get(grupoId) as { grupo_uuid: string; privado: number; senha_hash: string | null } | undefined;

      if (!groupInfo) {
        socket.emit('group_result', { success: false, msg: 'Grupo não encontrado' });
        return;
      }

      const { grupo_uuid, privado, senha_hash } = groupInfo;

      if (isUsernameTakenByOtherDevice(grupo_uuid, usuario, deviceId)) {
        socket.emit('group_result', {
          success: false,
          msg: `O nome "${usuario}" já está em uso por outro dispositivo neste grupo.`
        });
        return;
      }

      if (privado) {
        if (!password) {
          socket.emit('group_result', { success: false, msg: 'Este grupo é privado. Senha necessária.' });
          return;
        }
        if (!senha_hash || !bcrypt.compareSync(password, senha_hash)) {
          socket.emit('group_result', { success: false, msg: 'Senha incorreta' });
          return;
        }
      }

      let validUsuario = null;
      if (sessionToken) {
        validUsuario = validateSession(sessionToken, grupoId, deviceId);
      }

      let activeToken = sessionToken;
      const nowIso = new Date().toISOString();

      if (!validUsuario || validUsuario !== usuario) {
        const deleteOld = db.prepare(`DELETE FROM sessoes WHERE grupo_uuid = ? AND usuario = ? AND device_id = ?`);
        deleteOld.run(grupo_uuid, usuario, deviceId);

        activeToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

        const insertSession = db.prepare(`
          INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        insertSession.run(activeToken, grupo_uuid, usuario, deviceId, expiresAt, nowIso);
      } else {
        const updateSession = db.prepare(`UPDATE sessoes SET last_seen = ? WHERE session_token = ?`);
        updateSession.run(nowIso, sessionToken);
      }

      // Fetch message history (last 100)
      const histStmt = db.prepare(`
        SELECT usuario, mensagem, data_hora 
        FROM mensagens 
        WHERE grupo_uuid = ? 
        ORDER BY id ASC 
        LIMIT 100
      `);
      const historico = histStmt.all(grupo_uuid).map((r: any) => ({
        user: r.usuario,
        msg: r.mensagem,
        time: r.data_hora
      }));

      socket.join(grupoId);
      if (!connected_users[grupoId]) connected_users[grupoId] = {};
      
      for (const [sId, [uName, _, dId]] of Object.entries(connected_users[grupoId])) {
        if (uName === usuario && dId === deviceId) {
          delete connected_users[grupoId][sId];
        }
      }

      connected_users[grupoId][socket.id] = [usuario, activeToken, deviceId];
      const currentCount = Object.keys(connected_users[grupoId]).length;

      socket.emit('group_result', {
        success: true,
        grupo_id: grupoId,
        usuario,
        session_token: activeToken,
        device_id: deviceId,
        historico,
        user_count: currentCount,
        is_private: Boolean(privado),
        message: '✅ Conectado ao grupo!'
      });

      io.to(grupoId).emit('user_count_update', { grupo_id: grupoId, count: currentCount });
    } catch (err: any) {
      console.error('Error joining group:', err);
      socket.emit('group_result', { success: false, msg: 'Erro ao entrar no grupo: ' + err.message });
    }
  });

  socket.on('send_message', (data) => {
    const grupoId = (data?.grupo_id || '').trim();
    const usuario = (data?.usuario || '').trim();
    const sessionToken = (data?.session_token || '').trim();
    const deviceId = (data?.device_id || '').trim();
    let msg = (data?.msg || '').trim();

    if (!grupoId || !usuario || !sessionToken || !deviceId || !msg || msg.length > 500) {
      return;
    }

    const validUser = validateSession(sessionToken, grupoId, deviceId);
    if (!validUser || validUser !== usuario) {
      return;
    }

    try {
      const groupStmt = db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`);
      const group = groupStmt.get(grupoId) as { grupo_uuid: string } | undefined;
      if (!group) return;

      msg = sanitizeInput(msg, 500);
      const dataHora = new Date().toISOString();

      const insertMsg = db.prepare(`
        INSERT INTO mensagens (grupo_uuid, usuario, mensagem, data_hora)
        VALUES (?, ?, ?, ?)
      `);
      insertMsg.run(group.grupo_uuid, usuario, msg, dataHora);

      io.to(grupoId).emit('receive_message', {
        grupo_id: grupoId,
        usuario,
        msg,
        timestamp: dataHora
      });
    } catch (err) {
      console.error('Error sending message:', err);
    }
  });

  socket.on('leave_group', (data) => {
    const grupoId = data?.grupo_id;
    const sessionToken = data?.session_token;
    const deviceId = data?.device_id;

    if (grupoId && connected_users[grupoId] && connected_users[grupoId][socket.id]) {
      socket.leave(grupoId);
      delete connected_users[grupoId][socket.id];
      if (Object.keys(connected_users[grupoId]).length === 0) {
        delete connected_users[grupoId];
      }
      const count = Object.keys(connected_users[grupoId] || {}).length;
      io.to(grupoId).emit('user_count_update', { grupo_id: grupoId, count });
    }

    if (sessionToken && deviceId) {
      try {
        const delStmt = db.prepare(`DELETE FROM sessoes WHERE session_token = ? AND device_id = ?`);
        delStmt.run(sessionToken, deviceId);
      } catch (err) {
        console.error('Error removing session on leave:', err);
      }
    }

    socket.emit('left_group', { success: true, grupo_id: grupoId, message: '✅ Você saiu do grupo' });
  });

  socket.on('heartbeat', (data) => {
    const sessionToken = data?.session_token;
    const deviceId = data?.device_id;
    if (sessionToken && deviceId) {
      try {
        const stmt = db.prepare(`UPDATE sessoes SET last_seen = ? WHERE session_token = ? AND device_id = ?`);
        stmt.run(new Date().toISOString(), sessionToken, deviceId);
      } catch (err) {
        // silent
      }
    }
  });

  socket.on('request_recovery', (data) => {
    const grupoId = sanitizeInput(data?.grupo_id || '', 10);
    const usuario = sanitizeInput(data?.usuario || '', 15);
    const deviceId = (data?.device_id || '').trim();

    if (!grupoId || !usuario || !deviceId) {
      socket.emit('recovery_result', { success: false, msg: 'Dados inválidos para recuperação' });
      return;
    }

    try {
      const stmt = db.prepare(`
        SELECT g.grupo_uuid 
        FROM grupos g
        JOIN sessoes s ON g.grupo_uuid = s.grupo_uuid
        WHERE g.grupo_id = ? AND s.usuario = ? AND s.device_id = ?
      `);
      if (!stmt.get(grupoId, usuario, deviceId)) {
        socket.emit('recovery_result', { success: false, msg: 'Sessão anterior não encontrada para este dispositivo/usuário' });
        return;
      }

      const token = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 5 * 60 * 1000);

      temp_tokens[token] = { grupo_id: grupoId, usuario, device_id: deviceId, expires };

      socket.emit('recovery_result', {
        success: true,
        msg: `Token gerado com sucesso!`,
        token
      });
    } catch (err: any) {
      socket.emit('recovery_result', { success: false, msg: 'Erro na recuperação: ' + err.message });
    }
  });

  socket.on('verify_recovery', (data) => {
    const token = (data?.token || '').trim();
    const grupoId = sanitizeInput(data?.grupo_id || '', 10);
    const usuario = sanitizeInput(data?.usuario || '', 15);
    const deviceId = (data?.device_id || '').trim();

    const tokenInfo = temp_tokens[token];
    if (!tokenInfo) {
      socket.emit('recovery_verified', { success: false, msg: 'Token inválido' });
      return;
    }

    if (tokenInfo.expires.getTime() < Date.now()) {
      delete temp_tokens[token];
      socket.emit('recovery_verified', { success: false, msg: 'Token expirado' });
      return;
    }

    if (tokenInfo.grupo_id !== grupoId || tokenInfo.usuario !== usuario || tokenInfo.device_id !== deviceId) {
      socket.emit('recovery_verified', { success: false, msg: 'Token não corresponde aos dados informados' });
      return;
    }

    try {
      const groupStmt = db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`);
      const group = groupStmt.get(grupoId) as { grupo_uuid: string } | undefined;
      if (!group) {
        socket.emit('recovery_verified', { success: false, msg: 'Grupo não encontrado' });
        return;
      }

      const delStmt = db.prepare(`DELETE FROM sessoes WHERE grupo_uuid = ? AND usuario = ? AND device_id = ?`);
      delStmt.run(group.grupo_uuid, usuario, deviceId);

      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const nowIso = new Date().toISOString();

      const insertSession = db.prepare(`
        INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertSession.run(sessionToken, group.grupo_uuid, usuario, deviceId, expiresAt, nowIso);

      delete temp_tokens[token];

      socket.emit('recovery_verified', {
        success: true,
        msg: 'Acesso recuperado com sucesso!',
        session_token: sessionToken,
        grupo_id: grupoId,
        usuario,
        device_id: deviceId
      });
    } catch (err: any) {
      socket.emit('recovery_verified', { success: false, msg: 'Erro ao verificar token: ' + err.message });
    }
  });
});

// Setup Vite development middleware or static serving
if (process.env.NODE_ENV !== 'production') {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa'
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(process.cwd(), 'dist')));
  app.get('*', (_, res) => {
    res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
  });
}

httpServer.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 Chat Grupal Server running at http://0.0.0.0:${PORT}`);
});
