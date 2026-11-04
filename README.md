# Chat Grupal X9A

Aplicação de chat em grupo em tempo real, com autenticação por sessão, proteção por device ID, salas privadas e recuperação de acesso.

## Visão geral

O projeto usa:
- React + TypeScript + Vite no frontend
- Express + Socket.IO no backend
- SQLite para persistência local
- bcryptjs para hashing de senhas e chaves

## Funcionalidades

- criação de grupos públicos ou privados
- autenticação por token de sessão
- proteção por device ID para evitar identidade cruzada entre dispositivos
- recuperação de acesso com token temporário
- administração de grupo com chave de admin
- mensagens em tempo real via WebSockets
- limpeza de sessão ao sair do grupo

## Requisitos

- Node.js 20+
- npm

## Instalação

No diretório do projeto:

```bash
npm install --legacy-peer-deps
```

Se o projeto usa origem específica para CORS, crie o arquivo de ambiente:

```bash
cp .env.example .env
```

Exemplo de configuração:

```env
ALLOWED_ORIGIN=http://localhost:3000
```

Se quiser permitir mais de uma origem, separe por vírgula:

```env
ALLOWED_ORIGIN=http://localhost:3000,http://127.0.0.1:3000
```

## Execução em desenvolvimento

```bash
npm run dev
```

A aplicação fica disponível em:

```text
http://localhost:3000
```

## Produção

Build:

```bash
npm run build
```

Iniciar servidor em produção:

```bash
npm run start
```

## Segurança implementada

- validação de sessão por token e device
- bloqueio de uso de chave admin em join_group
- prevenção de identidade duplicada em outro dispositivo
- recuperação de acesso vinculada ao mesmo device
- hash de senhas e tokens de recuperação com bcrypt
- rate limiting básico para criação e recuperação

## Observações

- para ambientes locais, normalmente a origem permitida é `http://localhost:3000`
- o banco SQLite é criado automaticamente no diretório do projeto
- se houver problemas de compatibilidade de dependências, use `npm install --legacy-peer-deps`
