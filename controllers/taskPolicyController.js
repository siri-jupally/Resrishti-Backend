/*
  Task Policy Controller

  Purpose:
  - Admin endpoints to view and update task management settings.
  - Manager endpoint to read task policy (check permissions).

  Routes:
    Admin:
      - GET  /api/admin/task-policy   -> getTaskPolicy
      - PUT  /api/admin/task-policy   -> updateTaskPolicy
    Manager:
      - GET  /api/manager/task-policy -> getTaskPolicy (same handler)
*/
const TaskPolicy = require("../models/TaskPolicy");

// GET — returns the singleton task policy (creates default if missing)
const getTaskPolicy = async (req, res) => {
  try {
    let policy = await TaskPolicy.findOne();
    if (!policy) {
      policy = await TaskPolicy.create({});
    }
    res.json(policy);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT — admin updates task policy fields
const updateTaskPolicy = async (req, res) => {
  try {
    const { allowManagerTaskDeletion } = req.body;

    let policy = await TaskPolicy.findOne();
    if (!policy) {
      policy = new TaskPolicy();
    }

    if (allowManagerTaskDeletion !== undefined)
      policy.allowManagerTaskDeletion = allowManagerTaskDeletion;

    await policy.save();
    res.json(policy);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getTaskPolicy, updateTaskPolicy };
