FROM node:20-slim

# Install FFmpeg and curl
RUN apt-get update && \
    apt-get install -y ffmpeg curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

# Create temp and output directories
RUN mkdir -p temp output

EXPOSE 3000

CMD ["npm", "start"]
