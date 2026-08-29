module.exports = {
  apps: [
    {
      name: "backend-node",
      script: "server.js",
      cwd: "./backend",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    },
    {
      name: "api-ibero",
      script: "python3",
      args: "-m uvicorn main:app --host 0.0.0.0 --port 8090",
      cwd: "./API iberoamericana",
    },
    {
      name: "api-arabic",
      script: "python3",
      args: "-m uvicorn main:app --host 0.0.0.0 --port 9080",
      cwd: "./Arabic API",
    },
    {
      name: "api-espana",
      script: "python3",
      args: "-m uvicorn main:app --host 0.0.0.0 --port 8080",
      cwd: "./api-españa",
    },
    {
      name: "api-yacine",
      script: "python3",
      args: "-m uvicorn app:app --host 0.0.0.0 --port 8000",
      cwd: "./yacinetv-api",
    },
    {
      name: "api-movistar",
      script: "python3",
      args: "-m uvicorn main:app --host 0.0.0.0 --port 8070",
      cwd: "./api-movistar",
    }
  ]
};
