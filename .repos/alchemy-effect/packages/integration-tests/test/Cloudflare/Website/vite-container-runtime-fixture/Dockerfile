FROM node:22-alpine

WORKDIR /usr/src/app
RUN echo '{"name": "simple-node-app", "version": "1.0.0", "dependencies": {"ws": "^8.0.0"}}' > package.json
RUN npm install

COPY ./container/simple-node-app.cjs app.js
CMD [ "node", "app.js" ]
