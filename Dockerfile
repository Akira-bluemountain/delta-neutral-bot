FROM node:22-alpine

WORKDIR /app

# native モジュール(better-sqlite3)のビルドに必要
RUN apk add --no-cache python3 make g++

# 依存インストール
COPY package.json package-lock.json ./
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 60000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm ci --omit=dev --maxsockets=2

# ビルド済みファイルをコピー（ローカルでビルドして転送）
COPY dist/ ./dist/
COPY public/ ./public/

# データ・ログディレクトリ
RUN mkdir -p data logs

# 非root ユーザーで実行（UIDをホストのubuntuと同じ1000にする）
# node:22-alpine には UID 1000 の node ユーザーが既に存在する
RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
