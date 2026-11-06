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

- Node.js 22.13+
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
REDIS_URL=
HOST=0.0.0.0
PORT=3000
DATABASE_PATH=
```

Se quiser permitir mais de uma origem, separe por vírgula:

```env
ALLOWED_ORIGIN=http://localhost:3000,http://127.0.0.1:3000
```

Para compartilhar salas Socket.IO e contagens de usuários online entre múltiplas instâncias, configure `REDIS_URL` com a mesma URL Redis em cada instância. Sem essa variável, a presença fica limitada ao processo local. O banco SQLite também é local por padrão; Redis não compartilha grupos, sessões nem mensagens entre bancos separados.

O caminho do SQLite pode ser configurado com `DATABASE_PATH`; por padrão, o banco é criado como `chat_database.db` no diretório de execução.

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

Em produção, o servidor exige TLS configurado de uma destas formas:

- TLS direto: configure `TLS_CERT_PATH` e `TLS_KEY_PATH`; o processo inicia um listener HTTPS.
- Proxy: configure `TRUSTED_PROXY_TLS=true` somente quando houver um proxy confiável terminando HTTPS e a porta da aplicação estiver restrita à rede interna.

Não exponha diretamente à Internet um listener HTTP configurado para proxy.

## Segurança implementada

- validação de sessão por token e device
- bloqueio de uso de chave admin em join_group
- prevenção de identidade duplicada em outro dispositivo
- recuperação de acesso vinculada ao mesmo device
- hash de senhas e tokens de recuperação com bcrypt
- limite em memória de 20 tentativas de criação de grupo por IP a cada 15 minutos, além dos limites de recuperação/admin

Os limites são locais ao processo; em implantação com múltiplas instâncias, cada instância mantém contadores independentes.

## Testes

A suíte Socket.IO precisa de um servidor de teste na porta `3002`. Execute em um ambiente isolado, pois a suíte cria grupos e grava dados no banco configurado:

```bash
DATABASE_PATH=/tmp/chat-grupal-security-test.db PORT=3002 npm run start
```

Em outro terminal, no mesmo diretório:

```bash
DATABASE_PATH=/tmp/chat-grupal-security-test.db npm run test:security
```

Use um caminho temporário exclusivo e remova o banco de teste após a execução.

## Observações

- para ambientes locais, normalmente a origem permitida é `http://localhost:3000`
- o banco SQLite é criado automaticamente no caminho configurado ou no diretório de execução
- se houver problemas de compatibilidade de dependências, use `npm install --legacy-peer-deps`
