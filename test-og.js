const http = require('http');

// Helper to make a request
function makeRequest(path, userAgent) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 5000,
            path: path,
            method: 'GET',
            headers: {
                'User-Agent': userAgent
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data
                });
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        req.end();
    });
}

async function runTests() {
    // 1. Fetch a valid blog ID first (assuming one exists, otherwise we need to create or mock)
    // For this test, we'll try to fetch the list of blogs first to get an ID
    try {
        const blogsRes = await makeRequest('/api/blogs', 'NodeTest');
        const blogs = JSON.parse(blogsRes.body);

        if (blogs.length === 0) {
            console.log('No blogs found to test with. Please create a blog first.');
            return;
        }

        const blogSlug = blogs[0].slug;
        console.log(`Testing with Blog Slug: ${blogSlug}`);

        // 2. Test Bot Request
        console.log('\n--- Testing Bot Request (Facebook) ---');
        const botRes = await makeRequest(`/blogs/${blogSlug}`, 'facebookexternalhit/1.1');
        if (botRes.body.includes('<meta property="og:title"')) {
            console.log('✅ Success: OG tags found in response');
            const titleMatch = botRes.body.match(/<meta property="og:title" content="([^"]*)"/);
            console.log(`   OG Title: ${titleMatch ? titleMatch[1] : 'Not found'}`);
        } else {
            console.log('❌ Failure: No OG tags found');
            console.log(botRes.body.substring(0, 200));
        }

        // 3. Test Normal Request
        console.log('\n--- Testing Normal Request (Chrome) ---');
        const normalRes = await makeRequest(`/blogs/${blogSlug}`, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        if (normalRes.statusCode === 302 || normalRes.headers.location) {
            console.log(`✅ Success: Redirected to ${normalRes.headers.location}`);
        } else {
            console.log(`ℹ️ Received status ${normalRes.statusCode}. Body length: ${normalRes.body.length}`);
            // Note: express res.redirect sends 302 by default
        }

    } catch (error) {
        console.error('Test Error:', error);
    }
}

runTests();
