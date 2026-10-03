const { Server } = require("socket.io");

let io;

const initSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: [
                "https://resrishti.com",          // Production
                "https://www.resrishti.com",      // Production (www)
                "http://localhost:5173",          // Local Frontend
                "http://localhost:4000"           // Local Backend (if needed)
            ],
            methods: ["GET", "POST"],
            credentials: true
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

        // Join a specific pickup room so pickup/certificate status changes
        // (io.to(`pickup_<id>`).emit("pickup:status-updated")) reach the open
        // detail/timeline views live, without a page refresh.
        socket.on("joinPickupRoom", (pickupId) => {
            socket.join(`pickup_${pickupId}`);
            console.log(`Socket ${socket.id} joined room: pickup_${pickupId}`);
        });

        socket.on("leavePickupRoom", (pickupId) => {
            socket.leave(`pickup_${pickupId}`);
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
