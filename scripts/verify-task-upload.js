const fs = require('fs');

async function run() {
    const SERVER_URL = 'http://localhost:5000';
    const MANAGER_EMAIL = 'manager@example.com';
    const MANAGER_PASS = 'manager123';

    console.log(`Connecting to ${SERVER_URL}...`);

    // 1. Login
    const loginRes = await fetch(`${SERVER_URL}/api/manager/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: MANAGER_EMAIL, password: MANAGER_PASS })
    });

    if (!loginRes.ok) {
        console.error('Login failed:', loginRes.status, await loginRes.text());
        // Try to create manager if not exists?
        // Assume manager exists or run create-manager-direct.js manually if needed.
        return;
    }

    const { token } = await loginRes.json();
    console.log('Login successful.');

    // 2. Get Employees
    const empRes = await fetch(`${SERVER_URL}/api/manager/employees`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const employees = await empRes.json();
    if (employees.length === 0) {
        console.error('No employees found. Please create one via dashboard first.');
        return;
    }
    const empId = employees[0]._id;
    console.log(`Using employee: ${employees[0].name || employees[0].email} (${empId})`);

    // 3. Create Task with File
    const formData = new FormData();
    formData.append('title', 'Verification Task ' + Date.now());
    formData.append('description', 'This task was created by the verification script with an attachment.');
    formData.append('priority', 'medium');
    formData.append('employeeId', empId);

    // Create a dummy file blob
    const fileContent = "This is a test file for task upload verification.";
    const blob = new Blob([fileContent], { type: 'text/plain' });
    formData.append('file', blob, 'verification-doc.txt');

    console.log('Uploading task with file...');
    const taskRes = await fetch(`${SERVER_URL}/api/manager/tasks`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }, // Content-Type header excluded so browser/node sets boundary
        body: formData
    });

    if (!taskRes.ok) {
        console.error('Task creation failed:', taskRes.status, await taskRes.text());
        return;
    }

    const task = await taskRes.json();
    console.log('Task created successfully:', task._id);
    console.log('Task Messages:', JSON.stringify(task.messages, null, 2));

    // 4. Verify Attachment
    const attachmentMsg = task.messages.find(m => m.fileName === 'verification-doc.txt');
    if (attachmentMsg) {
        console.log('SUCCESS: Attachment found in task messages.');
        console.log(`File: ${attachmentMsg.fileName}, Key: ${attachmentMsg.s3Key}`);
    } else {
        console.error('FAILURE: Attachment NOT found in task messages.');
    }

    // 5. Clean up (optional - delete task using DB directly? No delete endpoint)
    console.log('Verification complete.');
}

run().catch(console.error);
