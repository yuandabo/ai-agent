import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error("❌ OPENAI_API_KEY 未设置，请检查 .env 文件");
  process.exit(1);
}

console.log("✅ OPENAI_API_KEY 已加载");
console.log(`   Key 前缀: ${apiKey.slice(0, 12)}...`);
console.log("   正在测试连接 api.openai.com...");

const client = new OpenAI({ apiKey });

try {
  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: "Hi",
  });
  console.log("✅ 连接成功");
  console.log("   回复:", response.output_text);
} catch (error) {
  console.error("❌ 请求失败:");
  console.error("   类型:", error.constructor.name);
  console.error("   状态码:", error.status);
  console.error("   错误码:", error.code);
  console.error("   信息:", error.message);

  if (error.status === 401) {
    console.error("\n💡 这是 API key 无效/已吊销，请去 OpenAI 后台重新生成 key");
  } else if (error.code === "ETIMEDOUT" || error.constructor.name.includes("Timeout")) {
    console.error("\n💡 这是网络超时，可能需要代理才能访问 OpenAI");
  }
}
