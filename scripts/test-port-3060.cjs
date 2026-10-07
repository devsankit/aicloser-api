const http = require('http');

async function testPort3060() {
  const { createServer } = await import('../dist/server.js');
  const { prisma } = await import('../dist/lib/prisma.js');
  const app = createServer();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(3060, resolve));
  console.log('✅ AIcloser-API server successfully listening on port 3060');

  try {
    const res = await fetch('http://127.0.0.1:3060/health');
    const data = await res.json();
    console.log('HTTP Status:', res.status);
    console.log('Health Output:', JSON.stringify(data, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    console.log('✅ Server and Prisma closed cleanly.');
  }
}

testPort3060().catch(console.error);
