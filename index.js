import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "socket.io";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cluster from "node:cluster";
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter";

const MAX_PLAYERS = 4;
const KEYWORDS = [
  "바나나",
  "자전거",
  "컴퓨터",
  "책",
  "휴대폰",
  "고양이",
  "비행기",
  "의자",
  "해변",
  "로봇",
];

let players = [];
let currentDrawerIndex = 0;
let gameState = {
  currentKeyword: null,
  currentDrawer: null,
  guessedCorrectly: false,
  winner: null,
};

if (cluster.isPrimary) {
  for (let i = 0; i < 4; i++) {
    cluster.fork({
      PORT: 3000 + i,
    });
  }
  setupPrimary();
} else {
  async function startServer() {
    const db = await open({
      filename: "game.db",
      driver: sqlite3.Database,
    });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS game_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const app = express();
    const server = createServer(app);
    const io = new Server(server, {
      connectionStateRecovery: {},
      adapter: createAdapter(),
    });

    const __dirname = dirname(fileURLToPath(import.meta.url));

    app.get("/", (req, res) => {
      res.sendFile(join(__dirname, "index.html"));
    });

    function selectRandomKeyword() {
      return KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
    }

    function startNewRound() {
      gameState.currentKeyword = selectRandomKeyword();
      gameState.guessedCorrectly = false;
      gameState.winner = null;

      io.emit("new-round", {
        keyword: gameState.currentKeyword,
        currentDrawer: players[currentDrawerIndex].id,
      });
    }

    io.on("connection", async (socket) => {
      if (players.length >= MAX_PLAYERS) {
        socket.emit("game-full");
        return;
      }

      const player = {
        id: socket.id,
        username: `Player ${players.length + 1}`,
      };
      players.push(player);

      if (players.length === 1) {
        currentDrawerIndex = 0;
        gameState.currentDrawer = socket.id;
        startNewRound();
      }

      io.emit("update-players", {
        players: players,
        currentDrawer: players[currentDrawerIndex].id,
        keyword: gameState.currentKeyword,
      });

      socket.on("drawing", (data) => {
        socket.broadcast.emit("drawing", data);
      });

      socket.on("clear-canvas", () => {
        socket.broadcast.emit("clear-canvas");
      });

      socket.on("chat message", async (message) => {
        if (
          message.text.trim().toLowerCase() ===
            gameState.currentKeyword.toLowerCase() &&
          socket.id !== gameState.currentDrawer
        ) {
          startNewRound();

          gameState.guessedCorrectly = true;
          gameState.winner = message.username;

          io.emit("game-won", {
            winner: message.username,
            keyword: gameState.currentKeyword,
          });

          currentDrawerIndex = (currentDrawerIndex + 1) % players.length;
          startNewRound();
        }

        io.emit("chat message", message);
        io.emit("update-players", {
          players: players,
          currentDrawer: players[currentDrawerIndex]?.id,
          keyword: gameState.currentKeyword,
        });

        try {
          await db.run(
            "INSERT INTO chat_messages (username, message) VALUES (?, ?)",
            message.username,
            message.text
          );
        } catch (e) {
          console.error("Error saving chat message:", e);
        }
      });

      socket.on("disconnect", () => {
        players = players.filter((p) => p.id !== socket.id);

        if (currentDrawerIndex >= players.length) {
          currentDrawerIndex = 0;
        }

        if (players.length > 0) {
          io.emit("update-players", {
            players: players,
            currentDrawer: players[currentDrawerIndex].id,
            keyword: gameState.currentKeyword,
          });
        }
      });
    });

    const port = process.env.PORT;

    server.listen(port, () => {
      console.log(`Game server running at http://localhost:${port}`);
    });
  }

  startServer().catch((error) => {
    console.error("Failed to start server:", error);
  });
}
