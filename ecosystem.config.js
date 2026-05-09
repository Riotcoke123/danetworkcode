module.exports = {
  apps: [
    {
      name: "rumble-web",
      // Point script directly to the gunicorn binary in your venv
      script: "./venv/bin/gunicorn",
      // The interpreter should be set to 'none' when calling a binary directly
      interpreter: "none",
      args: "-c gunicorn.conf.py flask_server:app",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
        FLASK_PORT: 5001
      }
    },
    {
      name: "rumble-scraper",
      script: "scraper.js", 
      interpreter: "node",  
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};