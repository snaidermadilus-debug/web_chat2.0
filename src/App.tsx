import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { MessageSquare, Shield, Users, Key, LogOut, ArrowRight, ArrowLeft, Send, CheckCircle, AlertCircle, PlusCircle, Lock, RefreshCw, UserCheck, Copy } from 'lucide-react';

let socket: Socket | null = null;

interface Message {
  user: string;
  msg: string;
  time: string;
}

export default function App() {
  const [screen, setScreen] = useState<'welcome' | 'options' | 'create' | 'join' | 'recovery' | 'chat'>('welcome');
  const [deviceId, setDeviceId] = useState<string>('');
  
  // App state
  const [currentGroup, setCurrentGroup] = useState<string>('');
  const [currentUser, setCurrentUser] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [isPrivate, setIsPrivate] = useState<boolean>(false);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [adminKey, setAdminKey] = useState<string>('');
  const [userCount, setUserCount] = useState<number>(0);
  const [messages, setMessages] = useState<Message[]>([]);
  
  // Form inputs
  const [createGrupo, setCreateGrupo] = useState<string>('');
  const [createNome, setCreateNome] = useState<string>('');
  const [createPassword, setCreatePassword] = useState<string>('');
  const [createPrivate, setCreatePrivate] = useState<boolean>(false);

  const [joinGrupo, setJoinGrupo] = useState<string>('');
  const [joinNome, setJoinNome] = useState<string>('');
  const [joinPassword, setJoinPassword] = useState<string>('');

  const [recoverGrupo, setRecoverGrupo] = useState<string>('');
  const [recoverNome, setRecoverNome] = useState<string>('');
  const [recoverToken, setRecoverToken] = useState<string>('');
  const [recoverAdminKey, setRecoverAdminKey] = useState<string>('');
  const [recoverSecretInput, setRecoverSecretInput] = useState<string>('');
  const [recoverySecret, setRecoverySecret] = useState<string>('');
  const [generatedToken, setGeneratedToken] = useState<string>('');
  const [showTokenSection, setShowTokenSection] = useState<boolean>(false);

  const [messageInput, setMessageInput] = useState<string>('');
  const [notification, setNotification] = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);
  
  // Modal state
  const [modalConfig, setModalConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    confirmLabel: string;
    isLoading?: boolean;
  } | null>(null);

  const [keysModalConfig, setKeysModalConfig] = useState<{
    isOpen: boolean;
    personalKey: string | null;
    adminKey: string | null;
  } | null>(null);

  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const heartbeatIntervalRef = useRef<any>(null);
  const currentGroupRef = useRef<string>('');

  useEffect(() => {
    currentGroupRef.current = currentGroup;
  }, [currentGroup]);

  // Initialize Device ID & Socket
  useEffect(() => {
    let dId = localStorage.getItem('chat_device_id');
    if (!dId) {
      dId = 'device_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      localStorage.setItem('chat_device_id', dId);
    }
    setDeviceId(dId);

    // Initialize socket
    socket = io({
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      transports: ['polling', 'websocket']
    });

    socket.on('connect', () => {
      showNotification('Conectado ao servidor', 'success');
    });

    socket.on('disconnect', () => {
      stopHeartbeat();
    });

    socket.on('group_result', (data: any) => {
      if (!data.success) {
        showNotification(data.msg, 'error');
        return;
      }

      setCurrentGroup(data.grupo_id);
      setCurrentUser(data.usuario);
      setSessionToken(data.session_token);
      setIsPrivate(data.is_private || false);
      setIsAdmin(data.is_admin || false);
      if (data.admin_key) {
        setAdminKey(data.admin_key);
      }
      if (data.device_id) {
        setDeviceId(data.device_id);
      }
      if (data.recovery_secret) {
        setRecoverySecret(data.recovery_secret);
      }

      saveSession(data.grupo_id, data.usuario, data.session_token, data.device_id || dId, data.admin_key, data.recovery_secret);
      setScreen('chat');

      if (data.historico && data.historico.length > 0) {
        setMessages(data.historico);
      } else {
        setMessages([]);
      }

      showNotification(data.message || 'Conectado!', 'success');
      startHeartbeat(data.session_token, data.device_id || dId);
    });

    socket.on('receive_message', (data: any) => {
      const activeGroup = currentGroupRef.current || localStorage.getItem('chat_session_group');
      if (data.grupo_id === activeGroup) {
        setMessages(prev => [...prev, { user: data.usuario, msg: data.msg, time: data.timestamp }]);
      }
    });

    socket.on('user_count_update', (data: any) => {
      setUserCount(data.count);
    });

    socket.on('recovery_result', (data: any) => {
      if (!data.success) {
        showNotification(data.msg, 'error');
        return;
      }
      setGeneratedToken(data.token);
      setShowTokenSection(true);
      showNotification('Token gerado com sucesso!', 'success');
    });

    socket.on('recovery_verified', (data: any) => {
      if (!data.success) {
        showNotification(data.msg, 'error');
        return;
      }
      setCurrentGroup(data.grupo_id);
      setCurrentUser(data.usuario);
      setSessionToken(data.session_token);
      if (data.admin_key) {
        setAdminKey(data.admin_key);
      }
      if (data.recovery_secret) {
        setRecoverySecret(data.recovery_secret);
      }
      setIsAdmin(data.is_admin || false);
      saveSession(data.grupo_id, data.usuario, data.session_token, data.device_id, data.admin_key, data.recovery_secret);
      
      socket?.emit('join_group', {
        grupo_id: data.grupo_id,
        usuario: data.usuario,
        session_token: data.session_token,
        device_id: data.device_id,
        admin_key: data.admin_key
      });
    });

    socket.on('left_group', (data: any) => {
      if (data.success) {
        resetChatState();
        setScreen('options');
        showNotification(data.message || 'Você saiu do grupo', 'info');
      }
    });

    socket.on('group_deleted', (data: any) => {
      resetChatState();
      setScreen('options');
      showNotification(data.msg || 'Grupo excluído pelo administrador.', 'info');
    });

    // Restore session check
    restoreSession();

    return () => {
      socket?.disconnect();
      stopHeartbeat();
    };
  }, []);

  // Auto scroll chat
  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [messages]);

  const showNotification = (msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ msg, type });
    setTimeout(() => {
      setNotification(null);
    }, 5000);
  };

  const startHeartbeat = (token: string, devId: string) => {
    stopHeartbeat();
    heartbeatIntervalRef.current = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('heartbeat', {
          session_token: token,
          device_id: devId
        });
      }
    }, 30000);
  };

  const stopHeartbeat = () => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  };

  const saveSession = (grupo: string, usuario: string, token: string, devId: string, admKey?: string, recSecret?: string) => {
    localStorage.setItem('chat_session_group', grupo);
    let currentAdminKey = admKey;
    let currentRecoverySecret = recSecret;
    if (currentAdminKey === undefined || currentRecoverySecret === undefined) {
      try {
        const prev = localStorage.getItem('chat_session');
        if (prev) {
          const parsed = JSON.parse(prev);
          if (currentAdminKey === undefined) currentAdminKey = parsed.admin_key;
          if (currentRecoverySecret === undefined) currentRecoverySecret = parsed.recovery_secret;
        }
      } catch (e) {}
    }
    if (currentRecoverySecret) {
      setRecoverySecret(currentRecoverySecret);
    }
    localStorage.setItem('chat_session', JSON.stringify({
      grupo_id: grupo,
      usuario,
      session_token: token,
      device_id: devId,
      admin_key: currentAdminKey || '',
      recovery_secret: currentRecoverySecret || '',
      timestamp: Date.now()
    }));
  };

  const restoreSession = () => {
    try {
      const saved = localStorage.getItem('chat_session');
      if (saved) {
        const data = JSON.parse(saved);
        const age = Date.now() - data.timestamp;
        if (age < 24 * 60 * 60 * 1000) {
          setCurrentGroup(data.grupo_id);
          setCurrentUser(data.usuario);
          setSessionToken(data.session_token);
          if (data.admin_key) {
            setAdminKey(data.admin_key);
          }
          if (data.recovery_secret) {
            setRecoverySecret(data.recovery_secret);
          }
          const devId = data.device_id || deviceId;
          if (data.device_id) setDeviceId(data.device_id);

          // Automatically rejoin group chat on reload
          const doJoin = () => {
            if (socket) {
              socket.emit('join_group', {
                grupo_id: data.grupo_id,
                usuario: data.usuario,
                session_token: data.session_token,
                device_id: devId,
                admin_key: data.admin_key || undefined
              });
            }
          };

          if (socket && socket.connected) {
            doJoin();
          } else {
            socket?.once('connect', doJoin);
          }
        } else {
          localStorage.removeItem('chat_session');
        }
      }
    } catch (e) {
      localStorage.removeItem('chat_session');
    }
  };

  const resetChatState = () => {
    setCurrentGroup('');
    setCurrentUser('');
    setSessionToken('');
    setAdminKey('');
    setIsAdmin(false);
    setUserCount(0);
    setMessages([]);
    localStorage.removeItem('chat_session');
    localStorage.removeItem('chat_session_group');
    stopHeartbeat();
  };

  // Actions
  const handleCreateGroup = () => {
    if (!createGrupo.trim() || !createNome.trim()) {
      showNotification('Preencha os campos obrigatórios', 'error');
      return;
    }
    socket?.emit('create_group', {
      grupo_id: createGrupo.trim(),
      usuario: createNome.trim(),
      password: createPassword,
      private: createPrivate,
      device_id: deviceId
    });
  };

  const handleJoinGroup = () => {
    if (!joinGrupo.trim() || !joinNome.trim()) {
      showNotification('Preencha os campos obrigatórios', 'error');
      return;
    }
    socket?.emit('join_group', {
      grupo_id: joinGrupo.trim(),
      usuario: joinNome.trim(),
      password: joinPassword,
      session_token: sessionToken,
      device_id: deviceId
    });
  };

  const handleRequestRecovery = () => {
    if (!recoverGrupo.trim() || !recoverNome.trim() || !recoverSecretInput.trim()) {
      showNotification('Preencha os campos obrigatórios, incluindo a Chave Pessoal', 'error');
      return;
    }
    socket?.emit('request_recovery', {
      grupo_id: recoverGrupo.trim(),
      usuario: recoverNome.trim(),
      recovery_secret: recoverSecretInput.trim(),
      device_id: deviceId
    });
  };

  const handleVerifyRecovery = () => {
    if (!recoverToken.trim() || !recoverGrupo.trim() || !recoverNome.trim()) {
      showNotification('Preencha todos os campos obrigatórios', 'error');
      return;
    }
    socket?.emit('verify_recovery', {
      token: recoverToken.trim(),
      grupo_id: recoverGrupo.trim(),
      usuario: recoverNome.trim(),
      device_id: deviceId,
      admin_key: recoverAdminKey.trim() || undefined
    });
  };

  const handleSendMessage = () => {
    if (!messageInput.trim()) return;
    socket?.emit('send_message', {
      grupo_id: currentGroup,
      usuario: currentUser,
      session_token: sessionToken,
      device_id: deviceId,
      msg: messageInput.trim()
    });
    setMessageInput('');
  };

  const handleLeaveGroup = () => {
    setModalConfig({
      isOpen: true,
      title: 'Sair do grupo?',
      message: 'Você deseja realmente sair do grupo?',
      confirmLabel: 'Sair do grupo',
      onConfirm: () => {
        socket?.emit('leave_group', {
          grupo_id: currentGroup,
          session_token: sessionToken,
          device_id: deviceId
        });
      }
    });
  };

  const handleDeleteGroup = () => {
    setModalConfig({
      isOpen: true,
      title: 'Excluir grupo?',
      message: `Você deseja realmente EXCLUIR o grupo "${currentGroup}"? Esta ação é irreversível.`,
      confirmLabel: 'Excluir grupo',
      onConfirm: () => {
        socket?.emit('delete_group', {
          grupo_id: currentGroup,
          session_token: sessionToken,
          device_id: deviceId,
          admin_key: adminKey || undefined
        });
      }
    });
  };

  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {
      return '--:--';
    }
  };

  return (
    <div className="min-h-screen bg-[#121212] text-white flex items-center justify-center p-4 relative overflow-x-hidden font-sans">
      {/* Background radial gradient glow */}
      <div className="fixed inset-0 pointer-events-none bg-[radial-gradient(circle_at_20%_80%,rgba(120,119,198,0.15)_0%,transparent_40%),radial-gradient(circle_at_80%_20%,rgba(255,119,198,0.1)_0%,transparent_40%),radial-gradient(circle_at_40%_40%,rgba(120,119,255,0.1)_0%,transparent_40%)] -z-10 animate-pulse" />

      {/* Floating notification */}
      {notification && (
        <div className={`fixed top-6 right-6 z-50 px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 backdrop-blur-xl border border-white/10 animate-bounce ${
          notification.type === 'error' ? 'bg-red-600/90 text-white' :
          notification.type === 'success' ? 'bg-emerald-600/90 text-white' : 'bg-purple-600/90 text-white'
        }`}>
          {notification.type === 'error' ? <AlertCircle className="w-5 h-5" /> : <CheckCircle className="w-5 h-5" />}
          <span className="font-medium">{notification.msg}</span>
        </div>
      )}

      {/* Screen 1: Welcome */}
      {screen === 'welcome' && (
        <div className="w-full max-w-[440px] bg-[#1c1c1ee6] rounded-[28px] shadow-[0_25px_80px_rgba(0,0,0,0.4)] border border-white/10 overflow-hidden backdrop-blur-xl animate-in fade-in zoom-in-95 duration-500">
          <div className="p-10 text-center relative">
            <div className="text-7xl mb-6 inline-block bg-gradient-to-br from-purple-500 via-cyan-400 to-pink-500 bg-clip-text text-transparent animate-bounce">
              💬
            </div>
            <h1 className="text-3xl font-extrabold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent mb-4 tracking-tight">
              Chat Grupal
            </h1>
            <p className="text-white/60 text-base mb-8 leading-relaxed max-w-[320px] mx-auto">
              Converse com seus amigos de forma privada, segura e em tempo real.
            </p>
            <button
              onClick={() => setScreen('options')}
              className="w-full py-5 px-8 rounded-2xl bg-gradient-to-r from-purple-600 to-cyan-500 text-white font-bold text-lg shadow-[0_12px_40px_rgba(138,43,226,0.3)] hover:shadow-[0_20px_50px_rgba(138,43,226,0.5)] hover:-translate-y-1 transition-all duration-300 flex items-center justify-center gap-3 uppercase tracking-wider mb-8"
            >
              <span>🚀</span>
              <span>Começar a Conversar</span>
            </button>
            <div className="bg-purple-500/5 rounded-2xl p-6 border border-purple-500/15 space-y-4 text-left">
              <div className="flex items-center gap-3 text-white/70 text-sm">
                <Shield className="w-5 h-5 text-purple-400 shrink-0" />
                <span>Nomes protegidos por dispositivo</span>
              </div>
              <div className="flex items-center gap-3 text-white/70 text-sm">
                <Lock className="w-5 h-5 text-cyan-400 shrink-0" />
                <span>Segurança máxima com criptografia</span>
              </div>
              <div className="flex items-center gap-3 text-white/70 text-sm">
                <Users className="w-5 h-5 text-pink-400 shrink-0" />
                <span>Salas públicas e privadas com senha</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Screen 2: Auth Options */}
      {screen === 'options' && (
        <div className="w-full max-w-[440px] bg-[#1c1c1ee6] rounded-[28px] shadow-[0_25px_80px_rgba(0,0,0,0.4)] border border-white/10 overflow-hidden backdrop-blur-xl animate-in fade-in zoom-in-95 duration-500">
          <div className="p-10">
            <h2 className="text-2xl font-extrabold text-white text-center mb-8 relative pb-3 after:content-[''] after:absolute after:bottom-0 after:left-1/4 after:w-1/2 after:h-[3px] after:bg-gradient-to-r after:from-purple-500 after:to-cyan-400 after:rounded-full">
              O que você quer fazer?
            </h2>
            <div className="space-y-4 mb-8">
              <button
                onClick={() => setScreen('create')}
                className="w-full bg-[#28282d] hover:bg-[#32323a] border border-white/10 hover:border-purple-500/40 rounded-2xl p-5 flex items-center gap-5 transition-all duration-300 group text-left"
              >
                <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-purple-600 to-purple-800 flex items-center justify-center text-2xl shadow-lg group-hover:scale-110 transition-transform">
                  🆕
                </div>
                <div className="flex-1">
                  <div className="font-bold text-lg text-white mb-1">Criar Grupo</div>
                  <div className="text-white/60 text-sm">Crie uma nova sala de chat</div>
                </div>
                <ArrowRight className="w-6 h-6 text-white/30 group-hover:text-purple-400 group-hover:translate-x-1 transition-all" />
              </button>

              <button
                onClick={() => setScreen('join')}
                className="w-full bg-[#28282d] hover:bg-[#32323a] border border-white/10 hover:border-cyan-500/40 rounded-2xl p-5 flex items-center gap-5 transition-all duration-300 group text-left"
              >
                <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-2xl shadow-lg group-hover:scale-110 transition-transform">
                  👥
                </div>
                <div className="flex-1">
                  <div className="font-bold text-lg text-white mb-1">Entrar em Grupo</div>
                  <div className="text-white/60 text-sm">Entre em uma sala existente</div>
                </div>
                <ArrowRight className="w-6 h-6 text-white/30 group-hover:text-cyan-400 group-hover:translate-x-1 transition-all" />
              </button>

              <button
                onClick={() => setScreen('recovery')}
                className="w-full bg-[#28282d] hover:bg-[#32323a] border border-white/10 hover:border-pink-500/40 rounded-2xl p-5 flex items-center gap-5 transition-all duration-300 group text-left"
              >
                <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center text-2xl shadow-lg group-hover:scale-110 transition-transform">
                  🔑
                </div>
                <div className="flex-1">
                  <div className="font-bold text-lg text-white mb-1">Recuperar Acesso</div>
                  <div className="text-white/60 text-sm">Retome sua sessão anterior</div>
                </div>
                <ArrowRight className="w-6 h-6 text-white/30 group-hover:text-pink-400 group-hover:translate-x-1 transition-all" />
              </button>
            </div>

            <button
              onClick={() => setScreen('welcome')}
              className="w-full py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-white/70 hover:text-white font-medium flex items-center justify-center gap-3 transition-all"
            >
              <ArrowLeft className="w-5 h-5" />
              <span>Voltar para Início</span>
            </button>
          </div>
        </div>
      )}

      {/* Screen 3: Create Group */}
      {screen === 'create' && (
        <div className="w-full max-w-[440px] bg-[#1c1c1ee6] rounded-[28px] shadow-[0_25px_80px_rgba(0,0,0,0.4)] border border-white/10 overflow-hidden backdrop-blur-xl animate-in fade-in zoom-in-95 duration-500">
          <div className="p-10">
            <h2 className="text-2xl font-extrabold text-white mb-8 flex items-center gap-3">
              <PlusCircle className="w-8 h-8 text-purple-400" />
              <span>Criar Novo Grupo</span>
            </h2>

            <div className="space-y-6">
              <div>
                <label className="block text-white/90 font-semibold mb-2 text-sm">Nome do Grupo (ID)</label>
                <input
                  type="text"
                  value={createGrupo}
                  onChange={e => setCreateGrupo(e.target.value)}
                  placeholder="Ex: amigos, devops"
                  maxLength={10}
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-purple-500 focus:ring-4 focus:ring-purple-500/20 transition-all"
                />
                <p className="text-xs text-white/40 mt-2">Máx. 10 caracteres (letras, números, - e _)</p>
              </div>

              <div>
                <label className="block text-white/90 font-semibold mb-2 text-sm">Seu Nome</label>
                <input
                  type="text"
                  value={createNome}
                  onChange={e => setCreateNome(e.target.value)}
                  placeholder="Como você será chamado"
                  maxLength={15}
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-purple-500 focus:ring-4 focus:ring-purple-500/20 transition-all"
                />
                <p className="text-xs text-white/40 mt-2">Máx. 15 caracteres</p>
              </div>

              <div>
                <label className="block text-white/90 font-semibold mb-2 text-sm">Senha (opcional)</label>
                <input
                  type="password"
                  value={createPassword}
                  onChange={e => setCreatePassword(e.target.value)}
                  placeholder="Proteja seu grupo"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-purple-500 focus:ring-4 focus:ring-purple-500/20 transition-all"
                />
              </div>

              <div className="bg-[#28282d] p-5 rounded-2xl border border-white/10 flex items-center gap-4 cursor-pointer hover:border-purple-500/40 transition-all"
                   onClick={() => setCreatePrivate(!createPrivate)}>
                <input
                  type="checkbox"
                  checked={createPrivate}
                  onChange={e => setCreatePrivate(e.target.checked)}
                  className="w-5 h-5 accent-purple-600 rounded cursor-pointer"
                />
                <div>
                  <div className="font-semibold text-white text-sm">🛡️ Tornar grupo privado</div>
                  <div className="text-xs text-white/50">Exige senha para novos participantes</div>
                </div>
              </div>

              <div className="space-y-3 pt-4">
                <button
                  onClick={handleCreateGroup}
                  className="w-full py-4 rounded-2xl bg-gradient-to-r from-purple-600 to-cyan-500 text-white font-bold text-base shadow-[0_8px_30px_rgba(138,43,226,0.3)] hover:shadow-[0_12px_40px_rgba(138,43,226,0.5)] hover:-translate-y-0.5 transition-all flex items-center justify-center gap-3"
                >
                  <span>✨</span>
                  <span>Criar Grupo</span>
                </button>

                <button
                  onClick={() => setScreen('options')}
                  className="w-full py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-white/70 hover:text-white font-medium flex items-center justify-center gap-3 transition-all"
                >
                  <ArrowLeft className="w-5 h-5" />
                  <span>Voltar para Opções</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Screen 4: Join Group */}
      {screen === 'join' && (
        <div className="w-full max-w-[440px] bg-[#1c1c1ee6] rounded-[28px] shadow-[0_25px_80px_rgba(0,0,0,0.4)] border border-white/10 overflow-hidden backdrop-blur-xl animate-in fade-in zoom-in-95 duration-500">
          <div className="p-10">
            <h2 className="text-2xl font-extrabold text-white mb-8 flex items-center gap-3">
              <Users className="w-8 h-8 text-cyan-400" />
              <span>Entrar em Grupo</span>
            </h2>

            <div className="space-y-6">
              <div>
                <label className="block text-white/90 font-semibold mb-2 text-sm">Nome do Grupo (ID)</label>
                <input
                  type="text"
                  value={joinGrupo}
                  onChange={e => setJoinGrupo(e.target.value)}
                  placeholder="Digite o ID do grupo"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/20 transition-all"
                />
              </div>

              <div>
                <label className="block text-white/90 font-semibold mb-2 text-sm">Seu Nome</label>
                <input
                  type="text"
                  value={joinNome}
                  onChange={e => setJoinNome(e.target.value)}
                  placeholder="Seu apelido no chat"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/20 transition-all"
                />
              </div>

              <div>
                <label className="block text-white/90 font-semibold mb-2 text-sm">Senha do Grupo</label>
                <input
                  type="password"
                  value={joinPassword}
                  onChange={e => setJoinPassword(e.target.value)}
                  placeholder="Se for privado"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/20 transition-all"
                />
                <p className="text-xs text-white/40 mt-2">Deixe em branco se for público</p>
              </div>

              <div className="space-y-3 pt-4">
                <button
                  onClick={handleJoinGroup}
                  className="w-full py-4 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-bold text-base shadow-[0_8px_30px_rgba(0,191,255,0.3)] hover:shadow-[0_12px_40px_rgba(0,191,255,0.5)] hover:-translate-y-0.5 transition-all flex items-center justify-center gap-3"
                >
                  <span>🚀</span>
                  <span>Entrar no Grupo</span>
                </button>

                <button
                  onClick={() => setScreen('options')}
                  className="w-full py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-white/70 hover:text-white font-medium flex items-center justify-center gap-3 transition-all"
                >
                  <ArrowLeft className="w-5 h-5" />
                  <span>Voltar para Opções</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Screen 5: Recovery */}
      {screen === 'recovery' && (
        <div className="w-full max-w-[440px] bg-[#1c1c1ee6] rounded-[28px] shadow-[0_25px_80px_rgba(0,0,0,0.4)] border border-white/10 overflow-hidden backdrop-blur-xl animate-in fade-in zoom-in-95 duration-500">
          <div className="p-10">
            <h2 className="text-2xl font-extrabold text-white mb-6 flex items-center gap-3">
              <Key className="w-8 h-8 text-pink-400" />
              <span>Recuperar Acesso</span>
            </h2>

            <p className="text-white/60 text-sm mb-6 bg-[#28282d] p-4 rounded-2xl border border-white/10">
              Solicite um token de verificação para restaurar seu acesso anterior neste dispositivo.
            </p>

            <div className="space-y-5">
              <div>
                <label className="block text-white/90 font-semibold mb-2 text-sm">Nome do Grupo</label>
                <input
                  type="text"
                  value={recoverGrupo}
                  onChange={e => setRecoverGrupo(e.target.value)}
                  placeholder="Grupo que você participa"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-pink-500 transition-all"
                />
              </div>

              <div>
                <label className="block text-white/90 font-semibold mb-2 text-sm">Seu Nome no Grupo</label>
                <input
                  type="text"
                  value={recoverNome}
                  onChange={e => setRecoverNome(e.target.value)}
                  placeholder="Como você se chamava"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-pink-500 transition-all"
                />
              </div>

              <div>
                <label className="block text-white/90 font-semibold mb-1 text-sm">Chave de Recuperação Pessoal <span className="text-pink-400">*</span></label>
                <p className="text-[11px] text-white/50 mb-2">Informe a chave secreta fornecida a você ao entrar no grupo (prova de identidade).</p>
                <input
                  type="text"
                  value={recoverSecretInput}
                  onChange={e => setRecoverSecretInput(e.target.value)}
                  placeholder="Sua chave pessoal de recuperação"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-pink-500 transition-all font-mono"
                />
              </div>

              {!showTokenSection ? (
                <button
                  onClick={handleRequestRecovery}
                  className="w-full py-4 rounded-2xl bg-gradient-to-r from-pink-500 to-purple-600 text-white font-bold text-base shadow-[0_8px_30px_rgba(255,0,255,0.3)] hover:shadow-[0_12px_40px_rgba(255,0,255,0.5)] transition-all flex items-center justify-center gap-3"
                >
                  <RefreshCw className="w-5 h-5" />
                  <span>Solicitar Token</span>
                </button>
              ) : (
                <div className="space-y-4 pt-4 border-t border-white/10 animate-in fade-in duration-300">
                  <div className="bg-purple-900/30 p-5 rounded-2xl border border-purple-500/30 text-center">
                    <div className="text-xs text-white/70 mb-2">Seu Token de Recuperação:</div>
                    <div className="text-xl md:text-2xl font-mono font-bold tracking-wider text-pink-400 select-all break-all">
                      {generatedToken}
                    </div>
                    <div className="text-[11px] text-white/40 mt-1">Expira em 5 minutos</div>
                  </div>

                  <div>
                    <label className="block text-white/90 font-semibold mb-2 text-sm">Digite o Token</label>
                    <input
                      type="text"
                      value={recoverToken}
                      onChange={e => setRecoverToken(e.target.value)}
                      placeholder="Token recebido"
                      maxLength={64}
                      className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white font-mono text-center text-sm md:text-base tracking-wider placeholder-white/30 focus:outline-none focus:border-pink-500 transition-all"
                    />
                  </div>

                  <div>
                    <label className="block text-white/90 font-semibold mb-1 text-sm">Chave de Administrador <span className="text-white/40 font-normal">(opcional)</span></label>
                    <p className="text-[11px] text-white/50 mb-2">Para recuperar os privilégios de administrador do grupo, informe a chave segura gerada na criação.</p>
                    <input
                      type="text"
                      value={recoverAdminKey}
                      onChange={e => setRecoverAdminKey(e.target.value)}
                      placeholder="Chave recebida na criação do grupo"
                      className="w-full p-3.5 bg-[#28282d] border border-white/10 rounded-2xl text-white font-mono text-xs placeholder-white/30 focus:outline-none focus:border-purple-500 transition-all"
                    />
                  </div>

                  <button
                    onClick={handleVerifyRecovery}
                    className="w-full py-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-cyan-500 text-white font-bold text-base shadow-[0_8px_30px_rgba(0,255,127,0.3)] hover:shadow-[0_12px_40px_rgba(0,255,127,0.5)] transition-all flex items-center justify-center gap-3"
                  >
                    <UserCheck className="w-5 h-5" />
                    <span>Verificar e Entrar</span>
                  </button>
                </div>
              )}

              <button
                onClick={() => { setShowTokenSection(false); setScreen('options'); }}
                className="w-full py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-white/70 hover:text-white font-medium flex items-center justify-center gap-3 transition-all mt-4"
              >
                <ArrowLeft className="w-5 h-5" />
                <span>Voltar para Opções</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Screen 6: Chat Room */}
      {screen === 'chat' && (
        <div className="fixed inset-0 z-50 bg-[#0a0a0a] flex flex-col animate-in fade-in duration-300">
          {/* Chat Header */}
          <header className="bg-gradient-to-r from-[#1a1a1a] to-[#2d2d2d] text-white px-6 py-4 flex items-center justify-between border-b border-white/10 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center gap-4">
              <div className="flex flex-col">
                <div className="text-xl font-bold flex items-center gap-2">
                  <span className="bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">💬 {currentGroup}</span>
                </div>
                <div className="text-xs text-white/60 flex items-center gap-2 mt-1">
                  <span className="w-2.5 h-2.5 bg-emerald-400 rounded-full animate-ping inline-block" />
                  <span>{userCount} online</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 bg-purple-500/10 px-4 py-2 rounded-2xl border border-purple-500/30 text-sm font-medium">
                <span>👤</span>
                <span>{currentUser}</span>
              </div>
              {isAdmin && (
                <div className="flex items-center gap-1.5 bg-amber-500/15 px-3 py-1.5 rounded-xl border border-amber-500/30 text-xs font-semibold text-amber-300">
                  <span>👑</span>
                  <span>Admin</span>
                </div>
              )}
              {isAdmin && adminKey && (
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(adminKey);
                    showNotification('Chave de Administrador copiada!', 'success');
                  }}
                  title="Copiar chave de recuperação do administrador"
                  className="hidden md:flex items-center gap-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-200 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5 text-amber-300" />
                  <span>Chave Admin</span>
                </button>
              )}
              <button
                onClick={() => setKeysModalConfig({ isOpen: true, personalKey: recoverySecret, adminKey: isAdmin ? adminKey : null })}
                className="hidden sm:flex items-center gap-1.5 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-purple-200 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer"
              >
                <Key className="w-3.5 h-3.5 text-purple-300" />
                <span>Chaves</span>
              </button>
              {isAdmin && (
                <button
                  onClick={handleDeleteGroup}
                  className="bg-red-500/10 hover:bg-red-600/30 border border-red-500/30 hover:border-red-500/50 text-red-200 px-4 py-2 rounded-xl font-medium text-sm flex items-center gap-2 transition-all cursor-pointer"
                >
                  <LogOut className="w-4 h-4 text-red-300" />
                  <span>Excluir Grupo</span>
                </button>
              )}
              <button
                onClick={handleLeaveGroup}
                className="bg-white/10 hover:bg-red-500/20 border border-white/15 hover:border-red-500/40 text-white px-4 py-2.5 rounded-xl font-medium text-sm flex items-center gap-2 transition-all group"
              >
                <LogOut className="w-4 h-4 text-white/70 group-hover:text-red-400 transition-colors" />
                <span>Sair</span>
              </button>
            </div>
          </header>

          {/* Messages Feed */}
          <div ref={chatMessagesRef} className="flex-1 overflow-y-auto p-6 space-y-4 bg-gradient-to-b from-[#0a0a0a] to-[#121212]">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-white/40 space-y-2">
                <MessageSquare className="w-12 h-12 stroke-[1.5] animate-pulse" />
                <p>Nenhuma mensagem ainda. Seja o primeiro a falar!</p>
              </div>
            ) : (
              messages.map((m, idx) => {
                const isMe = m.user === currentUser;
                return (
                  <div key={idx} className={`max-w-[85%] md:max-w-[65%] p-4 rounded-2xl relative shadow-lg backdrop-blur-md border border-white/5 ${
                    isMe ? 'ml-auto bg-gradient-to-br from-purple-600 to-cyan-500 text-white rounded-br-sm' : 'mr-auto bg-[#222228] text-white/95 rounded-bl-sm'
                  }`}>
                    <div className="font-semibold text-xs opacity-80 mb-1 flex items-center gap-1.5">
                      <span>{isMe ? '✓✓' : '👤'}</span>
                      <span>{m.user} {isMe && '(você)'}</span>
                    </div>
                    <div className="text-sm md:text-base leading-relaxed break-words py-0.5">
                      {m.msg}
                    </div>
                    <div className="text-[10px] opacity-70 mt-2 text-right flex items-center justify-end gap-1 font-mono">
                      <span>{formatTime(m.time)}</span>
                      <span>🕒</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Message Input Area */}
          <div className="p-4 md:p-6 bg-[#1a1a1ae6] border-t border-white/10 backdrop-blur-xl">
            <div className="max-w-4xl mx-auto flex items-center gap-3">
              <input
                type="text"
                value={messageInput}
                onChange={e => setMessageInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSendMessage(); }}
                placeholder="Digite sua mensagem..."
                maxLength={500}
                className="flex-1 p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-purple-500 focus:ring-4 focus:ring-purple-500/20 transition-all text-sm md:text-base"
              />
              <button
                onClick={handleSendMessage}
                disabled={!messageInput.trim()}
                className="w-14 h-14 rounded-2xl bg-gradient-to-r from-purple-600 to-cyan-500 text-white flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100 transition-all shrink-0 cursor-pointer"
              >
                <Send className="w-5 h-5 ml-0.5" />
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Modal Confirm */}
      {modalConfig && modalConfig.isOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[100] backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-[#1c1c1e] text-white rounded-3xl p-8 max-w-sm w-full border border-white/10 shadow-2xl">
            <h2 className="text-xl font-bold mb-3">{modalConfig.title}</h2>
            <p className="text-white/70 mb-8">{modalConfig.message}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setModalConfig({ ...modalConfig, isOpen: false })}
                className="flex-1 py-3 px-4 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium transition"
              >
                Cancelar
              </button>
              <button
                onClick={async () => {
                  setModalConfig({ ...modalConfig, isLoading: true });
                  await modalConfig.onConfirm();
                  setModalConfig(null);
                }}
                disabled={modalConfig.isLoading}
                className="flex-1 py-3 px-4 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold transition disabled:opacity-50"
              >
                {modalConfig.isLoading ? '...' : modalConfig.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keys Modal */}
      {keysModalConfig && keysModalConfig.isOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[100] backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-[#1c1c1e] text-white rounded-3xl p-8 max-w-sm w-full border border-white/10 shadow-2xl">
            <h2 className="text-xl font-bold mb-6">Suas Chaves</h2>
            <div className="space-y-6">
              {keysModalConfig.personalKey && (
                <div>
                  <label className="block text-white/70 text-xs mb-2 uppercase tracking-wider">Chave Pessoal de Recuperação</label>
                  <div className="flex items-center gap-2 p-3 bg-pink-900/20 border border-pink-500/20 rounded-xl">
                    <span className="font-mono text-pink-300 break-all flex-1">{keysModalConfig.personalKey}</span>
                    <button onClick={() => navigator.clipboard.writeText(keysModalConfig.personalKey!)} className="text-pink-300 hover:text-white">
                      <Copy className="w-5 h-5" />
                    </button>
                  </div>
                  <p className="text-[10px] text-white/50 mt-1">Guarde fora do celular. Se perder, não há como recuperar sua identidade.</p>
                </div>
              )}
              {keysModalConfig.adminKey && (
                <div>
                  <label className="block text-white/70 text-xs mb-2 uppercase tracking-wider">Chave Administrativa do Grupo</label>
                  <div className="flex items-center gap-2 p-3 bg-amber-900/20 border border-amber-500/20 rounded-xl">
                    <span className="font-mono text-amber-300 break-all flex-1">{keysModalConfig.adminKey}</span>
                    <button onClick={() => navigator.clipboard.writeText(keysModalConfig.adminKey!)} className="text-amber-300 hover:text-white">
                      <Copy className="w-5 h-5" />
                    </button>
                  </div>
                  <p className="text-[10px] text-white/50 mt-1">Permite exclusão do grupo.</p>
                </div>
              )}
            </div>
            <button
              onClick={() => setKeysModalConfig(null)}
              className="w-full mt-8 py-3 px-4 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold transition"
            >
              Entendido
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
