#!/bin/bash

# Check if NVM is installed
if ! command -v nvm &>/dev/null; then
    echo "NVM not found. Installing NVM..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

    # Source NVM to make it available in the current shell
    export NVM_DIR="$HOME/.nvm"
    [[ -s "$NVM_DIR/nvm.sh" ]] && \. "$NVM_DIR/nvm.sh"
    echo "NVM installed successfully."
else
    echo "NVM is already installed."
fi

# Install and use Node.js 18
echo "Installing and activating Node.js 18..."
nvm install 18
nvm use 18
node -v

# Navigate to home directory
cd ~

# Remove old application directory if exists
sudo rm -rf intelis-interfacing

# Clone repository
echo "Cloning repository..."
git clone https://github.com/deforay/intelis-interfacing
cd intelis-interfacing/

# Install dependencies (npm ci automatically deletes node_modules first)
echo "Installing dependencies..."
npm ci

# Rebuild native modules for current platform
echo "Rebuilding native modules..."
npm run postinstall

# Build electron application
echo "Building electron application..."
npm run electron:build

echo "Build process completed successfully!"
echo "Changing to release directory..."
cd release/

# List the built packages
echo "Built packages:"
ls -lh
