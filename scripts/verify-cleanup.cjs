async function main() {
  const loginRes = await fetch("http://127.0.0.1:3060/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "hello.ankitrathore@gmail.com", password: "Ankit@1143" })
  });
  const loginData = await loginRes.json();
  console.log("Login status:", loginRes.status, "Role:", loginData.data?.user?.role);

  const token = loginData.data?.token;
  const tenantsRes = await fetch("http://127.0.0.1:3060/api/v1/super-admin/tenants", {
    headers: { "Authorization": `Bearer ${token}` }
  });
  const tenantsData = await tenantsRes.json();
  console.log("Tenants status:", tenantsRes.status, "Workspaces Count:", tenantsData.data?.length);

  const payoutsRes = await fetch("http://127.0.0.1:3060/api/v1/payouts/balance", {
    headers: { "Authorization": `Bearer ${token}` }
  });
  const payoutsData = await payoutsRes.json();
  console.log("Payouts balance status:", payoutsRes.status, "Dynamic Commission Data:", payoutsData.data);
}

main().catch(console.error);
