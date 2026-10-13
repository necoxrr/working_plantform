# 生产镜像：Node 22 + 云端存储（进程无状态，不挂任何持久卷）
#
# 之所以能安全用 Alpine：云端的 libSQL 客户端走 @libsql/client/web（纯 JS 的
# fetch/HTTP 管线），不加载任何平台相关的原生二进制。
FROM node:22-alpine

WORKDIR /app

# 先只拷依赖清单，让依赖层可缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 再拷源码
COPY server/ ./server/
COPY public/ ./public/

ENV NODE_ENV=production
# 平台一般会注入 PORT；这里给个兜底值，方便本地 docker run 直接跑
ENV PORT=3000
EXPOSE 3000

# 健康检查打 /api/health（该接口免登录，专门为平台探测准备）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "server/index.js"]
