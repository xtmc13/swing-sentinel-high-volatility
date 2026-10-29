FROM node:22-alpine AS build
WORKDIR /code
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run check && npm run build

FROM node:22-alpine AS runtime
WORKDIR /code
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /code/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/boot.js"]
