import express, { urlencoded } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { createConnection } from "mysql2";
import dotenv from "dotenv";

const app = express();
const server = createServer(app);
dotenv.config();
const rooms = {};
let roomsCounter = 0;

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN,
  },
});

let connection;

const connectToDatabase = () => {
  connection = createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  connection.connect((error) => {
    if (error) {
      console.error("Failed to connect to the database:", error);
    } else {
      console.log("Connected to the database");
    }
  });
};

const closeDatabaseConnection = () => {
  if (connection) {
    connection.end((error) => {
      if (error) {
        console.error("Failed to close the database connection:", error);
      } else {
        console.log("Database connection closed");
      }
    });
  }
};

app.use(urlencoded({ extended: true }));
app.use(cors());

io.on("connection", (socket) => {
  if (roomsCounter === 0) {
    console.log("Connecting with the database...");
    connectToDatabase();
  }

  socket.on("createRoom", () => {
    roomsCounter++;
    console.log(`room created`);
    let roomId;
    do {
      roomId = Math.random().toString(36).substring(2, 10);
    } while (rooms[roomId] !== undefined);
    rooms[roomId] = {
      users: [],
      playerTurn: null,
      currentQuestion: {},
      playedQuestions: [],
      scores: [
        { player: "", score: 0 },
        { player: "", score: 0 },
      ],
      doubles: [
        { player: "", double: 0 },
        { player: "", double: 0 },
      ],
    };
    socket.join(roomId);
    rooms[roomId].users.push(socket.id);
    rooms[roomId].scores[0].player = socket.id;
    rooms[roomId].doubles[0].player = socket.id;

    socket.emit("roomCreated", roomId);
  });

  socket.on("joinRoom", (roomId) => {
    if (rooms[roomId] && rooms[roomId].users.length < 2) {
      socket.join(roomId);
      rooms[roomId].users.push(socket.id);
      rooms[roomId].scores[1].player = socket.id;
      rooms[roomId].doubles[1].player = socket.id;
      if (rooms[roomId].users.length === 2) {
        rooms[roomId].playerTurn =
          rooms[roomId].users[
            Math.floor(Math.random() * rooms[roomId].users.length)
          ];
        io.to(roomId).emit("startGame", {
          roomId: roomId,
          playerTurn: rooms[roomId].playerTurn,
        });
      }
    } else {
      socket.emit("roomError");
    }
  });

  socket.on("getQuestion", ({ roomId, category, level }) => {
    let obj = {};
    let answersId = [];

    connection
      .promise()
      .query(
        `SELECT COUNT(*) AS size FROM Question WHERE category = '${category}' AND level = ${level}`
      )
      .then(([result]) => {
        let random = Math.floor(Math.random() * result[0].size);
        return connection
          .promise()
          .query(
            `SELECT * FROM Question WHERE category = '${category}' AND level = ${level} LIMIT ${random}, 1;`
          );
      })
      .then(([rows]) => {
        obj.category = category;
        obj.level = level;
        obj.question = rows[0].question;
        obj.imageUrl = rows[0].imageUrl;
        obj.tip = rows[0].tip;
        obj.correctAns = rows[0].correctAns;
        answersId.push(rows[0].firstAnsId);
        answersId.push(rows[0].secondAnsId);
        answersId.push(rows[0].thirdAnsId);
        answersId.push(rows[0].fourthAnsId);
      })
      .then(() => {
        return Promise.all(
          answersId.map(async (data) => {
            const [rows] = await connection
              .promise()
              .query(`SELECT * FROM Answer WHERE id = '${data}'`);
            return rows[0].answer;
          })
        );
      })
      .then((answers) => {
        obj.answers = answers;
        rooms[roomId].currentQuestion = { ...obj };
        rooms[roomId].playedQuestions.push(category + level);
        io.to(roomId).emit("setQuestion", {
          category: category,
          level: level,
          question: obj.question,
          imageUrl: obj.imageUrl,
          answers: obj.answers,
        });
      })
      .catch((error) => {
        throw error;
      });
  });

  socket.on("useDouble", ({ roomId, playerId }) => {
    const doubleIndex = rooms[roomId].doubles[0].player == playerId ? 0 : 1;
    if (rooms[roomId].doubles[doubleIndex].double === 0) {
      rooms[roomId].doubles[doubleIndex].double = 1;
    }
    io.to(roomId).emit("responseDouble", playerId);
  });

  socket.on("useTip", ({ roomId, playerId }) => {
    io.to(roomId).emit("responseTip", {
      playerId: playerId,
      tip: rooms[roomId].currentQuestion.tip,
    });
  });

  socket.on("postAnswer", ({ roomId, answerId, playerId }) => {
    const currentPlayerIndex =
      playerId == rooms[roomId].scores[0].player ? 0 : 1;

    if (rooms[roomId].currentQuestion.correctAns === answerId) {
      rooms[roomId].scores[currentPlayerIndex].score +=
        rooms[roomId].currentQuestion.level;
      if (rooms[roomId].doubles[currentPlayerIndex].double === 1) {
        rooms[roomId].scores[currentPlayerIndex].score +=
          rooms[roomId].currentQuestion.level;
        rooms[roomId].doubles[currentPlayerIndex].double = -1;
      }
    } else {
      if (rooms[roomId].doubles[currentPlayerIndex].double === 1) {
        rooms[roomId].doubles[currentPlayerIndex].double = -1;
      }
    }

    rooms[roomId].playerTurn =
      rooms[roomId].playerTurn === rooms[roomId].users[0]
        ? rooms[roomId].users[1]
        : rooms[roomId].users[0];

    io.to(roomId).emit("revealAnswer", {
      playerAns: answerId,
      correctAns: rooms[roomId].currentQuestion.correctAns,
      scores: rooms[roomId].scores,
      doubles: rooms[roomId].doubles,
      playedQuestions: rooms[roomId].playedQuestions,
    });
    io.to(roomId).emit("setPlayerTurn", rooms[roomId].playerTurn);
    setTimeout(() => {
      if (rooms[roomId].playedQuestions.length == 18) {
        io.to(roomId).emit("endGame", rooms[roomId].scores);
      } else {
        io.to(roomId).emit("nextRound");
      }
    }, 7000);
  });

  socket.on("disconnect", () => {
    let foundActiveRoom = false;
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const userIndex = room.users.indexOf(socket.id);
      if (userIndex !== -1) {
        room.users.splice(userIndex, 1);
        if (room.users.length === 1) {
          io.to(roomId).emit("playerLeft");
        }
        if (room.users.length === 0) {
          delete rooms[roomId];
          roomsCounter--;
          console.log(`room deleted`);
        } else {
          foundActiveRoom = true;
        }
        break;
      }
    }

    if (roomsCounter === 0 && !foundActiveRoom) {
      closeDatabaseConnection();
    }
  });
});

server.listen(process.env.PORT, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});

process.on("SIGINT", () => {
  closeDatabaseConnection();
  process.exit();
});
