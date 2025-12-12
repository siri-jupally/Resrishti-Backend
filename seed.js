const axios = require('axios');

const seed = async () => {
    try {
        const res = await axios.post('http://localhost:5000/api/admin/seed', {
            email: 'admin@resristi.com',
            password: 'admin123'
        });
        console.log('Admin seeded:', res.data);
    } catch (error) {
        console.error('Error seeding admin:', error.response ? error.response.data : error.message);
    }
};

seed();
