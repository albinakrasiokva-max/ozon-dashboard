# BrandOS: образ для Railway и своего сервера
FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache tzdata

# Зависимости отдельным слоем — пересобираются, только когда меняется package-lock.json
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.html ozon.html server.js reviews-bot.js settings.json ./
COPY lib ./lib

# Данные (база, файлы документов, настройки) — на постоянном диске /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TZ=Europe/Moscow \
    DATA_DIR=/data \
    SETTINGS_FILE=/data/settings.json
# Диск подключается снаружи: на Railway — томом с путём /data, в docker-compose — через volumes.
# Инструкцию VOLUME не используем: Railway её не принимает.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
# Бот для отзывов Ozon — тот же образ, команда запуска: node reviews-bot.js
CMD ["node", "server.js"]
