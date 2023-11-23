import express, { urlencoded } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import pg from "pg";
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

const { Client } = pg;

const client = new Client({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: true,
});

const connectToDatabase = async () => {
  try {
    await client.connect();
    console.log("Connected to the database");
  } catch (error) {
    console.error("Failed to connect to the database:", error);
  }
};

connectToDatabase();

app.use(urlencoded({ extended: true }));
app.use(cors());

io.on("connection", (socket) => {
  //Runs when a user clicks on Create Room
  socket.on("createRoom", () => {
    roomsCounter++;
    console.log(`A room was created, total rooms active: ${roomsCounter}`);
    //Create unique room id and initialize the room properties
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
    //After the room is created, join the user that made the room and update room properties
    socket.join(roomId);
    rooms[roomId].users.push(socket.id);
    rooms[roomId].scores[0].player = socket.id;
    rooms[roomId].doubles[0].player = socket.id;

    socket.emit("roomCreated", roomId);
  });

  //Runs when a user clicks on Join Room, has the room id that they want to join, as parameter
  socket.on("joinRoom", (roomId) => {
    //Check if the room with the specific id exists and is not full (if it only has one user joined)
    if (rooms[roomId] && rooms[roomId].users.length < 2) {
      //Join the specific user to the room he asked for and update room properties
      socket.join(roomId);
      rooms[roomId].users.push(socket.id);
      rooms[roomId].scores[1].player = socket.id;
      rooms[roomId].doubles[1].player = socket.id;
      //Check if everything is ok and room has two users joined
      if (rooms[roomId].users.length === 2) {
        //Initialize the playerTurn with Math random
        rooms[roomId].playerTurn =
          rooms[roomId].users[
            Math.floor(Math.random() * rooms[roomId].users.length)
          ];
        //Emit start game to the users of that room, sending the room id and the id of the player who plays first
        io.to(roomId).emit("startGame", {
          roomId: roomId,
          playerTurn: rooms[roomId].playerTurn,
        });
      }
    } else {
      socket.emit("roomError");
    }
  });

  //Runs when a user asks for a new question, has the roomId, desired question category and desired question level as parameters
  socket.on("getQuestion", async ({ roomId, category, level }) => {
    try {
      //Get the total amount of questions that meet the specific category and level user asked for, from the db table Question
      const result = await client.query(
        `SELECT COUNT(*) AS size FROM Question WHERE category = $1 AND level = $2`,
        [category, level]
      );
      //Select a random number that will be used as index, to fetch a random question from the db, that meets the user's criteria
      const random = Math.floor(Math.random() * result.rows[0].size);
      //Fetch the randomly selected question from the db table Question
      const { rows } = await client.query(
        `SELECT * FROM Question WHERE category = $1 AND level = $2 OFFSET $3 LIMIT 1`,
        [category, level, random]
      );

      //Create the question obj that will store all the data fetched from the db
      const obj = {
        category,
        level,
        question: rows[0].question,
        imageurl: rows[0].imageurl,
        tip: rows[0].tip,
        correctans: rows[0].correctans,
      };

      //Create the answers id array, that will be used to fetch all the question's possible answers from the db table Answer
      const answersId = [
        rows[0].firstansid,
        rows[0].secondansid,
        rows[0].thirdansid,
        rows[0].fourthansid,
      ];

      //Get all the answers from the db table Answer and then save them to the question object
      const answersPromises = answersId.map((data) =>
        client.query("SELECT * FROM Answer WHERE id = $1", [data])
      );
      const answersResults = await Promise.all(answersPromises);
      const answers = answersResults.map((result) => result.rows[0].answer);

      obj.answers = answers;

      //Spread the created question object to the currentQuestion object, which is a property of the specific room
      rooms[roomId].currentQuestion = { ...obj };
      //Add a string to the playedQuestions array, that consists of the category and level of the question that was asked from the player
      rooms[roomId].playedQuestions.push(category + level);

      /*Afterwards, emit the setQuestion and send an object with the category and level that was asked, plus the question header, 
      the imageUrl (if it doesn't exist, it sends null) and all the possible answers*/
      io.to(roomId).emit("setQuestion", {
        category,
        level,
        question: obj.question,
        imageUrl: obj.imageurl,
        answers: obj.answers,
      });
    } catch (error) {
      console.error("Error fetching question from database:", error);
    }
  });

  //Runs when user asks to use the double help
  socket.on("useDouble", ({ roomId, playerId }) => {
    //Find out which double should be updated in the room's doubles array, based on the playerId
    const doubleIndex = rooms[roomId].doubles[0].player == playerId ? 0 : 1;
    //Update the doubles array and send back the response to all the users
    if (rooms[roomId].doubles[doubleIndex].double === 0) {
      rooms[roomId].doubles[doubleIndex].double = 1;
    }
    io.to(roomId).emit("responseDouble", playerId);
  });

  //Runs when user asks to use the tip help
  socket.on("useTip", ({ roomId, playerId }) => {
    //Send back to all users the question's tip and the player that asked for it
    io.to(roomId).emit("responseTip", {
      playerId: playerId,
      tip: rooms[roomId].currentQuestion.tip,
    });
  });

  //Runs when user clicks on one of the possible answers from the current question
  socket.on("postAnswer", ({ roomId, answerId, playerId }) => {
    //Find out which player sent the answer and save the correct index for array scores, which is a property to the current room
    const currentPlayerIndex =
      playerId == rooms[roomId].scores[0].player ? 0 : 1;

    //Check if the answer id that the user sent is equal to the correct answer id
    if (rooms[roomId].currentQuestion.correctans === answerId) {
      //If the answer was correct, increment the player's score by the number of the current question's level
      rooms[roomId].scores[currentPlayerIndex].score +=
        rooms[roomId].currentQuestion.level;
      /*If the player used the double help for the current question and was correct, 
      then add one more time the number of the current question's level to his total score*/
      if (rooms[roomId].doubles[currentPlayerIndex].double === 1) {
        rooms[roomId].scores[currentPlayerIndex].score +=
          rooms[roomId].currentQuestion.level;
        //Then, update the doubles array, so the user won't be able to ask for double help again
        rooms[roomId].doubles[currentPlayerIndex].double = -1;
      }
    } else {
      /*If the answer was wrong and the user had double help for the current question, 
      then just update the doubles array and make his double help disabled*/
      if (rooms[roomId].doubles[currentPlayerIndex].double === 1) {
        rooms[roomId].doubles[currentPlayerIndex].double = -1;
      }
    }

    //Finally, change the playerTurn
    rooms[roomId].playerTurn =
      rooms[roomId].playerTurn === rooms[roomId].users[0]
        ? rooms[roomId].users[1]
        : rooms[roomId].users[0];

    //Reveal the correct answer and send back the updated playerTurn, scores, doubles and the playedQuestions array
    io.to(roomId).emit("revealAnswer", {
      playerAns: answerId,
      correctAns: rooms[roomId].currentQuestion.correctans,
      scores: rooms[roomId].scores,
      doubles: rooms[roomId].doubles,
      playedQuestions: rooms[roomId].playedQuestions,
    });
    io.to(roomId).emit("setPlayerTurn", rooms[roomId].playerTurn);
    /*After a certain amount of time, tell to the client to end the game or proceed to the next round, 
    if the playedQuestions length is not equal to 18 (which is the total number of all the questions in an instance of the game)*/
    setTimeout(() => {
      if (rooms[roomId].playedQuestions.length == 18) {
        io.to(roomId).emit("endGame", rooms[roomId].scores);
      } else {
        io.to(roomId).emit("nextRound");
      }
    }, 7000);
  });

  //Runs when a user disconnects for any reason
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
          console.log(
            `A room was deleted, total rooms active: ${roomsCounter}.`
          );
        } else {
          foundActiveRoom = true;
        }
        break;
      }
    }

    if (roomsCounter === 0 && !foundActiveRoom) {
      console.log("All rooms are deleted and no active rooms found");
    }
  });
});

server.listen(process.env.PORT, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
