# Use official Playwright image containing Node.js and Chromium system dependencies
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci

# Copy the rest of the application files
COPY . .

# Expose port 3000
EXPOSE 3000

# Start Express server
CMD ["node", "server.js"]
