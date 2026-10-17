# 💬 Chat Grupal X9A - Secure Real-Time Chat

O **Chat Grupal X9A** é uma aplicação web moderna de chat em tempo real com segurança avançada, desenvolvida com **React**, **Node.js (Express)**, **Socket.io** e **SQLite**.

A aplicação permite criar e participar de salas de conversa públicas ou privadas, oferecendo proteção de identidade por dispositivo, criptografia de senhas, sessões seguras com tokens e um sistema de recuperação de acesso.

---

## 🌟 Funcionalidades Principais

- **Comunicação em Tempo Real**: Mensagens enviadas e recebidas instantaneamente via WebSockets / Socket.io.
- **Salas Públicas e Privadas**: Crie grupos abertos ou protegidos com senha criptografada (`bcrypt`).
- **Proteção de Identidade por Dispositivo (`Device ID`)**: Impede que outros usuários utilizem o mesmo nome de usuário em outro dispositivo na mesma sala.
- **Sessões Seguras com Tokens**: Gerenciamento automático de tokens de sessão com persistência e verificação de inatividade.
- **Recuperação de Acesso**: Sistema de verificação por token temporário de 6 dígitos (válido por 5 minutos) caso o usuário precise retomar seu acesso.
- **Interface Moderna (Glassmorphism & Dark Mode)**: Design altamente responsivo com animações suaves, indicadores de usuários online (`● X online`), marcação de mensagens próprias (`(você)`) e alertas dinâmicos.

---

## 🛠️ Arquitetura e Tecnologias

- **Frontend**: React 19, TypeScript, Tailwind CSS, Lucide React, Socket.io Client.
- **Backend**: Node.js, Express, Socket.io Server, Node SQLite (`node:sqlite`), `bcryptjs`.

---

## 📦 Como Executar o Projeto

### Pré-requisitos
- Node.js (versão 20 ou superior recomendada)
- Gerenciador de pacotes (`npm` ou `bun`)

### Instalação e Execução

1. Instale as dependências:
   ```bash
   npm install
   ```

2. Inicie o servidor de desenvolvimento (que executa o backend Express/Socket.io e o frontend Vite simultaneamente):
   ```bash
   npm run dev
   ```

3. Acesse a aplicação no seu navegador:
   ```text
   http://localhost:3000
   ```

---

## 🔒 Segurança e Boas Práticas

- **Sanitização de Entradas**: Todos os inputs são limpos e sanitizados no servidor para prevenir ataques de injeção e XSS.
- **Rate Limiting**: Proteção contra tentativas excessivas de criação de grupos e solicitações de recuperação.
- **Heartbeat & Inatividade**: O sistema monitora batimentos cardíacos dos clientes para atualizar o status online e gerenciar sessões inativas.
