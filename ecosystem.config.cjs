module.exports = {
  apps: [
    {
      name: 'claude-flightdeck',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        PORT: 1337
      },
      error_file: '~/.pm2/logs/claude-flightdeck-error.log',
      out_file: '~/.pm2/logs/claude-flightdeck-out.log',
      time: true
    }
  ]
};
