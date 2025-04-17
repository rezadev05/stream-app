module.exports = {
  apps: [
    {
      name: "stream-app",
      script: "src/server.js",
      instances: 1, // Ubah ke "max" jika ingin cluster mode
      autorestart: true,
      watch: false, // Ubah ke true jika ingin auto-restart saat file berubah (dev option)
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
      env_development: {
        NODE_ENV: "development",
      },
    },
    {
      name: "reset-password",
      script: "src/reset-password.js",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
