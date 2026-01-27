const { Server } = require("socket.io");

let io;

const initSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: "*", // Adjust for production
            methods: ["GET", "POST"],
        },
    });

    io.on("connection", (socket) => {
        console.log(`New client connected: ${socket.id}`);

        // Join a specific task room
        socket.on("joinTaskRoom", (taskId) => {
            socket.join(`task_${taskId}`);
            console.log(`Socket ${socket.id} joined room: task_${taskId}`);
        });

        socket.on("leaveTaskRoom", (taskId) => {
            socket.leave(`task_${taskId}`);
            console.log(`Socket ${socket.id} left room: task_${taskId}`);
        });

        socket.on("disconnect", () => {
            console.log(`Client disconnected: ${socket.id}`);
        });
    });

    return io;
};

const getIo = () => {
    if (!io) {
        throw new Error("Socket.io not initialized!");
    }
    return io;
};

module.exports = { initSocket, getIo };
