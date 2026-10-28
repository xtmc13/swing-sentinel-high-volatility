FROM node:22-alpine
WORKDIR /code
COPY package.json ./
COPY .env ./
COPY dist ./dist
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/boot.js"]
