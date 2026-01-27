const { io } = require("socket.io-client");

// Connect to the backend
const socket = io("http://localhost:5001");

const TASK_ID = "TEST-TASK-ID";

socket.on("connect", () => {
    console.log("Connected to server:", socket.id);

    // Join the task room
    console.log(`Joining room: task_${TASK_ID}`);
    socket.emit("joinTaskRoom", TASK_ID);
});

socket.on("message:new", (data) => {
    console.log("Received new message event:", data);
    if (data.taskId === TASK_ID) {
        console.log("SUCCESS: Verification passed!");
        process.exit(0);
    }
});

socket.on("disconnect", () => {
    console.log("Disconnected from server");
});

// Keep alive for a bit
setTimeout(() => {
    console.log("Timeout waiting for message. Please trigger a message creation via API/App to verify.");
    process.exit(1);
}, 60000); // 60 seconds

