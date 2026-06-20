# node:22-alpine tracks the latest Node 22 LTS patch. Was node:alpine3.18
# which pinned Node 22.2 — too old for `process.getBuiltinModule()` that
# bson 6.x calls, causing the container to crash on boot after a fresh
# npm install pulled the newer bson.
FROM node:22-alpine
WORKDIR /app
VOLUME /app/uploads
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 4000
CMD [ "npm", "run", "start" ]
