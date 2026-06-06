module.exports = {
  apps: [
    {
      name: "node-backend",
      script: "./server.js",
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};