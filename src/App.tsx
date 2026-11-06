import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { MessageSquare, Shield, Users, Key, LogOut, ArrowRight, ArrowLeft, Send, CheckCircle, AlertCircle, PlusCircle, Lock, RefreshCw, UserCheck, Copy } from 'lucide-react';

let socket: Socket | null = null;

interface Message {
  id: number;
  user: string;
  msg: string;
  time: string;
}

interface PendingMessage {
  clientMsgId: string;
  text: string;
  grupoId: string;
  usuario: string;
  sessionToken: string;
  deviceId: string;
  attempts: number;
  status: 'queued' | 'sending' | 'failed';
}

type MessageDeliveryState = 'idle' | 'queued' | 'sending' | 'failed';
type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'rejoining' | 'failed';

interface ActiveSession {
  grupo_id: string;
  usuario: string;
  session_token: string;
  device_id: string;
}

const MAX_MESSAGE_ATTEMPTS = 3;
const MESSAGE_ACK_TIMEOUT_MS = 5000;
const MAX_MESSAGES_IN_STATE = 1000;

function mergeMessageWindow(current: Message[], incoming: Message[], olderPage = false) {
  const byId = new Map(current.map(message => [message.id, message]));
  incoming.forEach(message => byId.set(message.id, message));
  const messages = [...byId.values()].sort((left, right) => left.id - right.id);
  return messages.length <= MAX_MESSAGES_IN_STATE
    ? messages
    : olderPage ? messages.slice(0, MAX_MESSAGES_IN_STATE) : messages.slice(-MAX_MESSAGES_IN_STATE);
}

function generateClientMsgId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // Fallback if randomUUID fails
    }
  }
  return 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
}

export default function App() {
  const [screen, setScreen] = useState<'welcome' | 'options' | 'create' | 'join' | 'recovery' | 'chat'>('welcome');
  const [deviceId, setDeviceId] = useState<string>('');
  
  // App state
  const [currentGroup, setCurrentGroup] = useState<string>('');
  const [currentUser, setCurrentUser] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [adminKey, setAdminKey] = useState<string>('');
  const [userCount, setUserCount] = useState<number>(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState<boolean>(false);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [isBrowsingHistory, setIsBrowsingHistory] = useState<boolean>(false);
  const [newMessageCount, setNewMessageCount] = useState<number>(0);
  const [messageDeliveryState, setMessageDeliveryState] = useState<MessageDeliveryState>('idle');
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  
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
  const activeSessionRef = useRef<ActiveSession | null>(null);
  const hasConnectedRef = useRef<boolean>(false);
  const rejoinPendingRef = useRef<boolean>(false);
  const messagesRef = useRef<Message[]>([]);
  const recoveryAdminKeyRef = useRef<string>('');
  const reclaimAdminKeyRef = useRef<string>('');
  const pendingMessageRef = useRef<PendingMessage | null>(null);
  const messageRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyBeforeIdRef = useRef<number | null>(null);
  const historyRequestPendingRef = useRef<boolean>(false);
  const historyRequestGroupRef = useRef<string>('');
  const historyPrependScrollHeightRef = useRef<number | null>(null);
  const restoringSessionRef = useRef<boolean>(false);
  const historyViewingOlderRef = useRef<boolean>(false);

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
      setConnectionState('connected');
      const activeSession = activeSessionRef.current;
      if (hasConnectedRef.current && activeSession) {
        setConnectionState('rejoining');
        rejoinPendingRef.current = true;
        socket?.emit('join_group', activeSession);
      }
      hasConnectedRef.current = true;
      const pendingMessage = pendingMessageRef.current;
      if (pendingMessage && pendingMessage.status !== 'failed') sendPendingMessage(pendingMessage);
    });

    socket.on('disconnect', () => {
      setConnectionState('reconnecting');
      stopHeartbeat();
      clearMessageRetryTimer();
      const pendingMessage = pendingMessageRef.current;
      if (pendingMessage) {
        pendingMessage.status = 'queued';
        setMessageDeliveryState('queued');
      }
    });
    socket.io.on('reconnect_attempt', () => setConnectionState('reconnecting'));
    socket.io.on('reconnect_failed', () => {
      setConnectionState('failed');
      showNotification('Não foi possível reconectar ao servidor.', 'error');
    });

    socket.on('group_result', (data: any) => {
      if (!data.success) {
        restoringSessionRef.current = false;
        rejoinPendingRef.current = false;
        resetChatState();
        setScreen('options');
        showNotification(data.msg || 'Grupo não encontrado ou excluído', 'error');
        return;
      }

      rejoinPendingRef.current = false;
      restoringSessionRef.current = false;
      setConnectionState('connected');
      activeSessionRef.current = {
        grupo_id: data.grupo_id,
        usuario: data.usuario,
        session_token: data.session_token,
        device_id: data.device_id || dId
      };
      setCurrentGroup(data.grupo_id);
      setCurrentUser(data.usuario);
      setSessionToken(data.session_token);
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

      saveSession(data.grupo_id, data.usuario, data.session_token, data.device_id || dId);
      setScreen('chat');

      setMessages([]);
      messagesRef.current = [];
      historyViewingOlderRef.current = false;
      setIsBrowsingHistory(false);
      setNewMessageCount(0);
      historyBeforeIdRef.current = null;
      historyRequestGroupRef.current = data.grupo_id;
      historyRequestPendingRef.current = true;
      setHistoryHasMore(false);
      setHistoryLoading(true);
      socket?.emit('load_history', {
        grupo_id: data.grupo_id,
        session_token: data.session_token,
        device_id: data.device_id || dId,
        limit: 30
      });

      showNotification(data.message || 'Conectado!', 'success');
      startHeartbeat(data.grupo_id, data.session_token, data.device_id || dId);
    });

    socket.on('receive_message', (data: any) => {
      const activeGroup = currentGroupRef.current || localStorage.getItem('chat_session_group');
      if (data.grupo_id === activeGroup) {
        if (historyViewingOlderRef.current) {
          setNewMessageCount(count => count + 1);
          return;
        }
        const nextMessages = mergeMessageWindow(messagesRef.current, [{ id: Number(data.id), user: data.usuario, msg: data.msg, time: data.timestamp }]);
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
      }
    });

    socket.on('history_result', (data: any) => {
      if (data.grupo_id !== historyRequestGroupRef.current) return;
      historyRequestPendingRef.current = false;
      setHistoryLoading(false);
      if (!data.success) {
        setHistoryHasMore(false);
        showNotification(data.msg || 'Não foi possível carregar o histórico.', 'error');
        return;
      }

      const incomingMessages: Message[] = data.messages || [];
      const isOlderPage = data.before_id !== null;
      if (data.before_id !== null && chatMessagesRef.current) {
        historyPrependScrollHeightRef.current = chatMessagesRef.current.scrollHeight;
        historyViewingOlderRef.current = true;
        setIsBrowsingHistory(true);
      } else {
        historyViewingOlderRef.current = false;
        setIsBrowsingHistory(false);
        setNewMessageCount(0);
      }
      const nextMessages = mergeMessageWindow(messagesRef.current, incomingMessages, isOlderPage);
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      historyBeforeIdRef.current = data.next_before_id;
      setHistoryHasMore(Boolean(data.has_more));
    });

    socket.on('message_result', (data: any) => {
      const pendingMessage = pendingMessageRef.current;
      if (!pendingMessage || data.client_msg_id !== pendingMessage.clientMsgId) return;

      clearMessageRetryTimer();
      if (!data.success) {
        pendingMessage.status = 'failed';
        setMessageDeliveryState('failed');
        showNotification(data.msg || 'Não foi possível enviar a mensagem.', 'error');
        return;
      }

      pendingMessageRef.current = null;
      setMessageDeliveryState('idle');
      if (data.message && currentGroupRef.current === pendingMessage.grupoId) {
        const nextMessages = mergeMessageWindow(messagesRef.current, [data.message as Message]);
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
      }
      setMessageInput(current => current === pendingMessage.text && currentGroupRef.current === pendingMessage.grupoId ? '' : current);
      showNotification('Mensagem entregue.', 'success');
    });

    socket.on('user_count_update', (data: any) => {
      const activeGroup = currentGroupRef.current || localStorage.getItem('chat_session_group');
      if (data.grupo_id === activeGroup) setUserCount(data.count);
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
      const recoveredDeviceId = data.device_id || deviceId;
      setCurrentGroup(data.grupo_id);
      setCurrentUser(data.usuario);
      setSessionToken(data.session_token);
      setDeviceId(recoveredDeviceId);
      setAdminKey(data.is_admin ? recoveryAdminKeyRef.current : '');
      if (data.recovery_secret) {
        setRecoverySecret(data.recovery_secret);
      }
      setIsAdmin(data.is_admin || false);
      saveSession(data.grupo_id, data.usuario, data.session_token, recoveredDeviceId);
      
      socket?.emit('join_group', {
        grupo_id: data.grupo_id,
        usuario: data.usuario,
        session_token: data.session_token,
        device_id: recoveredDeviceId
      });
    });

    socket.on('session_revoked', (data: { reason: 'left' | 'recovered' | 'expired' }) => {
      resetChatState();
      setScreen('options');
      showNotification(
        data.reason === 'left' ? 'Sua sessão foi encerrada.' :
          data.reason === 'recovered' ? 'A sessão foi substituída pela recuperação de acesso.' :
            'Sua sessão expirou por inatividade.',
        'info'
      );
    });

    socket.on('admin_result', (data: { success: boolean; msg: string }) => {
      if (data.success) {
        setIsAdmin(true);
        setAdminKey(reclaimAdminKeyRef.current);
      }
      reclaimAdminKeyRef.current = '';
      showNotification(data.msg, data.success ? 'success' : 'error');
    });

    socket.on('left_group', (data: any) => {
      if (data.success) {
        resetChatState();
        setScreen('options');
        showNotification(data.message || 'Você saiu do grupo', 'info');
      } else {
        showNotification(data.msg || 'Não foi possível sair do grupo.', 'error');
      }
    });

    socket.on('group_deleted', (data: any) => {
      resetChatState();
      setScreen('options');
      showNotification(data.msg || 'Grupo não encontrado ou excluído', 'info');
    });

    // Restore session check
    restoreSession();

    return () => {
      socket?.disconnect();
      stopHeartbeat();
      clearMessageRetryTimer();
      if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
      socket?.io.off('reconnect_attempt');
      socket?.io.off('reconnect_failed');
    };
  }, []);

  // Auto scroll chat
  useEffect(() => {
    messagesRef.current = messages;
    if (chatMessagesRef.current) {
      const previousHeight = historyPrependScrollHeightRef.current;
      if (previousHeight !== null) {
        chatMessagesRef.current.scrollTop += chatMessagesRef.current.scrollHeight - previousHeight;
        historyPrependScrollHeightRef.current = null;
      } else {
        chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
      }
    }
  }, [messages]);

  const showNotification = (msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
    setNotification({ msg, type });
    notificationTimerRef.current = setTimeout(() => {
      setNotification(null);
      notificationTimerRef.current = null;
    }, 5000);
  };

  const copyToClipboard = async (value: string, label: string) => {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch {}
    }
    if (!copied) {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      try {
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        textarea.remove();
      }
    }
    showNotification(copied ? `${label} copiada.` : `Não foi possível copiar ${label.toLowerCase()}.`, copied ? 'success' : 'error');
  };

  const clearMessageRetryTimer = () => {
    if (messageRetryTimerRef.current) {
      clearTimeout(messageRetryTimerRef.current);
      messageRetryTimerRef.current = null;
    }
  };

  const sendPendingMessage = (pendingMessage = pendingMessageRef.current) => {
    if (!pendingMessage || pendingMessageRef.current?.clientMsgId !== pendingMessage.clientMsgId || pendingMessage.status === 'failed') return;
    const activeSocket = socket;
    if (!activeSocket?.connected) {
      pendingMessage.status = 'queued';
      setMessageDeliveryState('queued');
      return;
    }

    clearMessageRetryTimer();
    pendingMessage.attempts += 1;
    pendingMessage.status = 'sending';
    setMessageDeliveryState('sending');
    activeSocket.emit('send_message', {
      grupo_id: pendingMessage.grupoId,
      usuario: pendingMessage.usuario,
      session_token: pendingMessage.sessionToken,
      device_id: pendingMessage.deviceId,
      client_msg_id: pendingMessage.clientMsgId,
      msg: pendingMessage.text
    });

    messageRetryTimerRef.current = setTimeout(() => {
      const currentPending = pendingMessageRef.current;
      if (!currentPending || currentPending.clientMsgId !== pendingMessage.clientMsgId) return;
      if (!socket?.connected) {
        currentPending.status = 'queued';
        setMessageDeliveryState('queued');
      } else if (currentPending.attempts < MAX_MESSAGE_ATTEMPTS) {
        sendPendingMessage(currentPending);
      } else {
        currentPending.status = 'failed';
        setMessageDeliveryState('failed');
      }
    }, MESSAGE_ACK_TIMEOUT_MS);
  };

  const startHeartbeat = (grupoId: string, token: string, devId: string) => {
    stopHeartbeat();
    heartbeatIntervalRef.current = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('heartbeat', {
          grupo_id: grupoId,
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

  const saveSession = (grupo: string, usuario: string, token: string, devId: string) => {
    localStorage.setItem('chat_session_group', grupo);
    localStorage.setItem('chat_session', JSON.stringify({
      grupo_id: grupo,
      usuario,
      session_token: token,
      device_id: devId,
      timestamp: Date.now()
    }));
  };

  const restoreSession = () => {
    try {
      const saved = localStorage.getItem('chat_session');
      if (saved) {
        const data = JSON.parse(saved);
        if (
          typeof data.grupo_id === 'string' &&
          typeof data.usuario === 'string' &&
          typeof data.session_token === 'string' &&
          typeof data.device_id === 'string' &&
          data.device_id.length > 0
        ) {
          restoringSessionRef.current = true;
          setCurrentGroup(data.grupo_id);
          setCurrentUser(data.usuario);
          setSessionToken(data.session_token);
          const devId = data.device_id;
          setDeviceId(devId);

          // Automatically rejoin group chat on reload
          const doJoin = () => {
            if (socket) {
              socket.emit('join_group', {
                grupo_id: data.grupo_id,
                usuario: data.usuario,
                session_token: data.session_token,
                device_id: devId
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
          localStorage.removeItem('chat_session_group');
        }
      }
    } catch (e) {
      localStorage.removeItem('chat_session');
      localStorage.removeItem('chat_session_group');
    }
  };

  const resetChatState = () => {
    clearMessageRetryTimer();
    const hadPendingMessage = pendingMessageRef.current !== null;
    pendingMessageRef.current = null;
    setMessageDeliveryState('idle');
    setMessageInput('');
    if (hadPendingMessage) {
      showNotification('Envio pendente cancelado; confira o histórico antes de reenviar.', 'info');
    }
    setCurrentGroup('');
    setCurrentUser('');
    setSessionToken('');
    setAdminKey('');
    setIsAdmin(false);
    setRecoverySecret('');
    setUserCount(0);
    setMessages([]);
    messagesRef.current = [];
    activeSessionRef.current = null;
    rejoinPendingRef.current = false;
    historyBeforeIdRef.current = null;
    historyRequestPendingRef.current = false;
    historyRequestGroupRef.current = '';
    historyPrependScrollHeightRef.current = null;
    setHistoryHasMore(false);
    setHistoryLoading(false);
    historyViewingOlderRef.current = false;
    setIsBrowsingHistory(false);
    setJoinGrupo('');
    setJoinNome('');
    setJoinPassword('');
    setCreateGrupo('');
    setCreateNome('');
    setCreatePassword('');
    setRecoverGrupo('');
    setRecoverNome('');
    setRecoverToken('');
    setRecoverSecretInput('');
    setGeneratedToken('');
    setShowTokenSection(false);
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
    if (createPrivate && !createPassword.trim()) {
      showNotification('Defina uma senha para criar um grupo privado.', 'error');
      return;
    }
    if (!createPrivate && createPassword.trim()) {
      showNotification('Selecione Grupo Privado para criar um grupo com senha.', 'error');
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

  const handleReclaimAdmin = (adminKey: string) => {
    reclaimAdminKeyRef.current = adminKey;
    socket?.emit('reclaim_admin', {
      grupo_id: currentGroup,
      session_token: sessionToken,
      device_id: deviceId,
      admin_key: adminKey
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
    recoveryAdminKeyRef.current = recoverAdminKey.trim();
    socket?.emit('verify_recovery', {
      token: recoverToken.trim(),
      grupo_id: recoverGrupo.trim(),
      usuario: recoverNome.trim(),
      device_id: deviceId,
      admin_key: recoverAdminKey.trim() || undefined
    });
  };

  const handleLoadMoreHistory = () => {
    const beforeId = historyBeforeIdRef.current;
    if (!historyHasMore || beforeId === null || historyRequestPendingRef.current || !socket?.connected) return;
    historyRequestPendingRef.current = true;
    historyViewingOlderRef.current = true;
    setIsBrowsingHistory(true);
    setHistoryLoading(true);
    socket.emit('load_history', {
      grupo_id: currentGroup,
      session_token: sessionToken,
      device_id: deviceId,
      before_id: beforeId,
      limit: 30
    });
  };

  const handleReturnToLatest = () => {
    if (!socket?.connected || historyRequestPendingRef.current) return;
    historyViewingOlderRef.current = false;
    setIsBrowsingHistory(false);
    setNewMessageCount(0);
    historyBeforeIdRef.current = null;
    historyRequestGroupRef.current = currentGroup;
    historyRequestPendingRef.current = true;
    setHistoryLoading(true);
    setHistoryHasMore(false);
    messagesRef.current = [];
    setMessages([]);
    socket.emit('load_history', {
      grupo_id: currentGroup,
      session_token: sessionToken,
      device_id: deviceId,
      limit: 30
    });
  };

  const handleSendMessage = () => {
    const message = messageInput.trim();
    if (!message) return;
    if (pendingMessageRef.current !== null && pendingMessageRef.current.status !== 'failed') return;
    const clientMsgId = generateClientMsgId();
    const pendingMessage: PendingMessage = {
      clientMsgId,
      text: message,
      grupoId: currentGroup,
      usuario: currentUser,
      sessionToken,
      deviceId,
      attempts: 0,
      status: 'queued'
    };
    pendingMessageRef.current = pendingMessage;
    setMessageInput('');
    setMessageDeliveryState('queued');
    sendPendingMessage(pendingMessage);
  };

  const handleRetryPendingMessage = () => {
    const pendingMessage = pendingMessageRef.current;
    if (!pendingMessage) return;
    pendingMessage.attempts = 0;
    pendingMessage.status = 'queued';
    setMessageDeliveryState('queued');
    sendPendingMessage(pendingMessage);
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
        }`} role={notification.type === 'error' ? 'alert' : 'status'} aria-live={notification.type === 'error' ? 'assertive' : 'polite'}>
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
                <label htmlFor="create-group-id" className="block text-white/90 font-semibold mb-2 text-sm">Nome do Grupo (ID)</label>
                <input
                  id="create-group-id"
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
                <label htmlFor="create-user-name" className="block text-white/90 font-semibold mb-2 text-sm">Seu Nome</label>
                <input
                  id="create-user-name"
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
                <label htmlFor="create-group-password" className="block text-white/90 font-semibold mb-2 text-sm">Senha {createPrivate ? '(obrigatória)' : '(opcional)'}</label>
                <input
                  id="create-group-password"
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
                  aria-label="Tornar grupo privado"
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
                <label htmlFor="join-group-id" className="block text-white/90 font-semibold mb-2 text-sm">Nome do Grupo (ID)</label>
                <input
                  id="join-group-id"
                  type="text"
                  value={joinGrupo}
                  onChange={e => setJoinGrupo(e.target.value)}
                  placeholder="Digite o ID do grupo"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/20 transition-all"
                />
              </div>

              <div>
                <label htmlFor="join-user-name" className="block text-white/90 font-semibold mb-2 text-sm">Seu Nome</label>
                <input
                  id="join-user-name"
                  type="text"
                  value={joinNome}
                  onChange={e => setJoinNome(e.target.value)}
                  placeholder="Seu apelido no chat"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/20 transition-all"
                />
              </div>

              <div>
                <label htmlFor="join-group-password" className="block text-white/90 font-semibold mb-2 text-sm">Senha do Grupo</label>
                <input
                  id="join-group-password"
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
                <label htmlFor="recovery-group-id" className="block text-white/90 font-semibold mb-2 text-sm">Nome do Grupo</label>
                <input
                  id="recovery-group-id"
                  type="text"
                  value={recoverGrupo}
                  onChange={e => setRecoverGrupo(e.target.value)}
                  placeholder="Grupo que você participa"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-pink-500 transition-all"
                />
              </div>

              <div>
                <label htmlFor="recovery-user-name" className="block text-white/90 font-semibold mb-2 text-sm">Seu Nome no Grupo</label>
                <input
                  id="recovery-user-name"
                  type="text"
                  value={recoverNome}
                  onChange={e => setRecoverNome(e.target.value)}
                  placeholder="Como você se chamava"
                  className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-pink-500 transition-all"
                />
              </div>

              <div>
                <label htmlFor="recovery-secret" className="block text-white/90 font-semibold mb-1 text-sm">Chave de Recuperação Pessoal <span className="text-pink-400">*</span></label>
                <p className="text-[11px] text-white/50 mb-2">Informe a chave secreta fornecida a você ao entrar no grupo (prova de identidade).</p>
                <input
                  id="recovery-secret"
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
                    <label htmlFor="recovery-token" className="block text-white/90 font-semibold mb-2 text-sm">Digite o Token</label>
                    <input
                      id="recovery-token"
                      type="text"
                      value={recoverToken}
                      onChange={e => setRecoverToken(e.target.value)}
                      placeholder="Token recebido"
                      maxLength={64}
                      className="w-full p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white font-mono text-center text-sm md:text-base tracking-wider placeholder-white/30 focus:outline-none focus:border-pink-500 transition-all"
                    />
                  </div>

                  <div>
                    <label htmlFor="recovery-admin-key" className="block text-white/90 font-semibold mb-1 text-sm">Chave de Administrador <span className="text-white/40 font-normal">(opcional)</span></label>
                    <p className="text-[11px] text-white/50 mb-2">Para recuperar os privilégios de administrador do grupo, informe a chave segura gerada na criação.</p>
                    <input
                      id="recovery-admin-key"
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
          <header className="bg-gradient-to-r from-[#1a1a1a] to-[#2d2d2d] text-white px-3 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center gap-4">
              <div className="flex flex-col">
                <div className="text-xl font-bold flex items-center gap-2">
                  <span className="bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">💬 {currentGroup}</span>
                </div>
                <div className="text-xs text-white/60 flex items-center gap-2 mt-1">
                  <span className={`w-2.5 h-2.5 rounded-full inline-block ${connectionState === 'connected' ? 'bg-emerald-400 animate-ping' : 'bg-amber-400'}`} />
                  <span>
                    {connectionState === 'connected' ? `${userCount} online` :
                      connectionState === 'rejoining' ? 'Restabelecendo sala...' :
                        connectionState === 'failed' ? 'Sem conexão' : 'Reconectando...'}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
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
                  onClick={() => void copyToClipboard(adminKey, 'Chave de Administrador')}
                    aria-label="Copiar chave de administrador"
                  title="Copiar chave de recuperação do administrador"
                  className="hidden md:flex items-center gap-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-200 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5 text-amber-300" />
                  <span>Chave Admin</span>
                </button>
              )}
              <button
                onClick={() => setKeysModalConfig({ isOpen: true, personalKey: recoverySecret, adminKey: isAdmin ? adminKey : null })}
                aria-label="Abrir chaves de recuperação"
                className="flex items-center gap-1.5 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-purple-200 px-2 sm:px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer"
              >
                <Key className="w-3.5 h-3.5 text-purple-300" />
                <span>Chaves</span>
              </button>
              {isAdmin && (
                <button
                  onClick={handleDeleteGroup}
                  aria-label="Excluir grupo"
                  className="bg-red-500/10 hover:bg-red-600/30 border border-red-500/30 hover:border-red-500/50 text-red-200 px-4 py-2 rounded-xl font-medium text-sm flex items-center gap-2 transition-all cursor-pointer"
                >
                  <LogOut className="w-4 h-4 text-red-300" />
                  <span className="hidden sm:inline">Excluir Grupo</span>
                </button>
              )}
              <button
                onClick={handleLeaveGroup}
                aria-label="Sair do grupo"
                className="bg-white/10 hover:bg-red-500/20 border border-white/15 hover:border-red-500/40 text-white px-4 py-2.5 rounded-xl font-medium text-sm flex items-center gap-2 transition-all group"
              >
                <LogOut className="w-4 h-4 text-white/70 group-hover:text-red-400 transition-colors" />
                <span className="hidden sm:inline">Sair</span>
              </button>
            </div>
          </header>

          {/* Messages Feed */}
          <div ref={chatMessagesRef} role="log" aria-label="Mensagens do grupo" aria-live="polite" className="flex-1 overflow-y-auto p-6 space-y-4 bg-gradient-to-b from-[#0a0a0a] to-[#121212]">
            {historyHasMore && (
              <div className="flex justify-center">
                <button
                  onClick={handleLoadMoreHistory}
                  disabled={historyLoading}
                  className="px-4 py-2 text-sm text-cyan-200 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl disabled:opacity-50"
                >
                  {historyLoading ? 'Carregando...' : 'Carregar mensagens anteriores'}
                </button>
              </div>
            )}
            {isBrowsingHistory && (
              <div className="flex justify-center">
                <button
                  onClick={handleReturnToLatest}
                  disabled={historyLoading}
                  className="px-4 py-2 text-sm text-purple-200 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl disabled:opacity-50"
                >
                  {newMessageCount > 0 ? `${newMessageCount} novas mensagens — voltar ao final` : 'Voltar às mensagens recentes'}
                </button>
              </div>
            )}
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-white/40 space-y-2">
                <MessageSquare className="w-12 h-12 stroke-[1.5] animate-pulse" />
                <p>{historyLoading ? 'Carregando histórico...' : 'Nenhuma mensagem ainda. Seja o primeiro a falar!'}</p>
              </div>
            ) : (
              messages.map(m => {
                const isMe = m.user === currentUser;
                return (
                  <div key={m.id} className={`max-w-[85%] md:max-w-[65%] p-4 rounded-2xl relative shadow-lg backdrop-blur-md border border-white/5 ${
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
            {messageDeliveryState !== 'idle' && (
              <div className="max-w-4xl mx-auto mb-3 flex items-center justify-between gap-3 text-xs text-white/60" role="status" aria-live="polite">
                <span>
                  {messageDeliveryState === 'queued' ? 'Aguardando conexão para enviar...' :
                    messageDeliveryState === 'sending' ? 'Enviando e aguardando confirmação...' :
                      'Falha no envio. Mensagem mantida na caixa.'}
                </span>
                {messageDeliveryState === 'failed' && (
                  <button
                    onClick={handleRetryPendingMessage}
                    aria-label="Tentar enviar a mensagem novamente"
                    className="flex items-center gap-1.5 text-cyan-200 hover:text-white"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Tentar novamente</span>
                  </button>
                )}
              </div>
            )}
            <div className="max-w-4xl mx-auto flex items-center gap-3">
              <input
                type="text"
                id="chat-message"
                value={messageInput}
                aria-label="Mensagem"
                onChange={e => setMessageInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSendMessage(); }}
                placeholder="Digite sua mensagem..."
                maxLength={500}
                className="flex-1 p-4 bg-[#28282d] border border-white/10 rounded-2xl text-white placeholder-white/30 focus:outline-none focus:border-purple-500 focus:ring-4 focus:ring-purple-500/20 transition-all text-sm md:text-base"
              />
              <button
                onClick={handleSendMessage}
                aria-label="Enviar mensagem"
                disabled={!messageInput.trim() || (messageDeliveryState !== 'idle' && messageDeliveryState !== 'failed')}
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
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[100] backdrop-blur-sm animate-in fade-in duration-200" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
          <div className="bg-[#1c1c1e] text-white rounded-3xl p-8 max-w-sm w-full border border-white/10 shadow-2xl">
            <h2 id="confirm-modal-title" className="text-xl font-bold mb-3">{modalConfig.title}</h2>
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
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[100] backdrop-blur-sm animate-in fade-in duration-200" role="dialog" aria-modal="true" aria-labelledby="keys-modal-title">
          <div className="bg-[#1c1c1e] text-white rounded-3xl p-8 max-w-sm w-full border border-white/10 shadow-2xl">
            <h2 id="keys-modal-title" className="text-xl font-bold mb-6">Suas Chaves</h2>
            <div className="space-y-6">
              {keysModalConfig.personalKey && (
                <div>
                  <div className="block text-white/70 text-xs mb-2 uppercase tracking-wider">Chave Pessoal de Recuperação</div>
                  <div className="flex items-center gap-2 p-3 bg-pink-900/20 border border-pink-500/20 rounded-xl">
                    <span className="font-mono text-pink-300 break-all flex-1">{keysModalConfig.personalKey}</span>
                    <button onClick={() => void copyToClipboard(keysModalConfig.personalKey!, 'Chave pessoal')} aria-label="Copiar chave pessoal de recuperação" className="text-pink-300 hover:text-white">
                      <Copy className="w-5 h-5" />
                    </button>
                  </div>
                  <p className="text-[10px] text-white/50 mt-1">Guarde fora do celular. Se perder, não há como recuperar sua identidade.</p>
                </div>
              )}
              {keysModalConfig.adminKey && (
                <div>
                  <div className="block text-white/70 text-xs mb-2 uppercase tracking-wider">Chave Administrativa do Grupo</div>
                  <div className="flex items-center gap-2 p-3 bg-amber-900/20 border border-amber-500/20 rounded-xl">
                    <span className="font-mono text-amber-300 break-all flex-1">{keysModalConfig.adminKey}</span>
                    <button onClick={() => void copyToClipboard(keysModalConfig.adminKey!, 'Chave de administrador')} aria-label="Copiar chave administrativa" className="text-amber-300 hover:text-white">
                      <Copy className="w-5 h-5" />
                    </button>
                  </div>
                  <p className="text-[10px] text-white/50 mt-1">Permite recuperar privilégios administrativos.</p>
                </div>
              )}
              {!isAdmin && (
                <div>
                  <label htmlFor="adminKeyInput" className="block text-white/70 text-xs mb-2 uppercase tracking-wider">Recuperar Admin</label>
                  <input type="text" id="adminKeyInput" aria-label="Chave administrativa" placeholder="Cole sua chave admin aqui" className="w-full p-3 bg-[#28282d] border border-white/10 rounded-xl text-white font-mono text-xs placeholder-white/30" />
                  <button onClick={() => {
                      const key = (document.getElementById('adminKeyInput') as HTMLInputElement).value;
                      handleReclaimAdmin(key);
                      setKeysModalConfig(null);
                  }} className="w-full mt-2 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold transition">Recuperar</button>
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
