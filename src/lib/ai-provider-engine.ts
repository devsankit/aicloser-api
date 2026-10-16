import { prisma } from './prisma.js';
import { logger } from './logger.js';

export interface AiProviderConfig {
  id: string; // 'groq' | 'gemini' | 'openai' | 'fallback'
  name: string;
  enabled: boolean;
  model: string;
  apiKey?: string | null;
  priority: number;
  timeoutMs: number;
}

export interface AiGenerationResult {
  reply: string;
  provider: string;
  model: string;
  confidence: number;
  tokensUsed: number;
  latencyMs: number;
  suggestedFollowUps: string[];
  matchedIntent: string;
  sources: string[];
}

export const DEFAULT_AI_PROVIDERS: AiProviderConfig[] = [
  {
    id: 'groq',
    name: 'Groq Cloud (Fast LLaMA 3.3)',
    enabled: true,
    model: 'llama-3.3-70b-versatile',
    priority: 1,
    timeoutMs: 4000,
  },
  {
    id: 'gemini',
    name: 'Google Gemini 1.5 Flash',
    enabled: true,
    model: 'gemini-1.5-flash',
    priority: 2,
    timeoutMs: 4000,
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT-4o Mini)',
    enabled: true,
    model: 'gpt-4o-mini',
    priority: 3,
    timeoutMs: 4000,
  },
  {
    id: 'fallback',
    name: 'Deterministic Consultative Closer Engine',
    enabled: true,
    model: 'aicloser-consultative-v1',
    priority: 4,
    timeoutMs: 500,
  },
];

// Helper: Call Groq API
async function callGroq(apiKey: string, model: string, systemPrompt: string, userMessage: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.5,
        max_tokens: 350,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Groq API HTTP ${res.status}: ${errText.slice(0, 150)}`);
    }

    const data = (await res.json()) as any;
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty completion from Groq');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Helper: Call Google Gemini API
async function callGemini(apiKey: string, model: string, systemPrompt: string, userMessage: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const modelName = model || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\nUser message: ${userMessage}` }],
          },
        ],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 350,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini API HTTP ${res.status}: ${errText.slice(0, 150)}`);
    }

    const data = (await res.json()) as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Empty completion from Gemini');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Helper: Call OpenAI API
async function callOpenAI(apiKey: string, model: string, systemPrompt: string, userMessage: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.5,
        max_tokens: 350,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI API HTTP ${res.status}: ${errText.slice(0, 150)}`);
    }

    const data = (await res.json()) as any;
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty completion from OpenAI');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Deterministic Consultative Fallback Engine
function executeDeterministicFallback(
  message: string,
  customerName: string,
  botConfig: any
): { reply: string; matchedIntent: string; suggestedFollowUps: string[]; sources: string[] } {
  const cleanMessage = message.trim();

  // 1. Check workspace training QA pairs
  const trainingQA = Array.isArray(botConfig?.trainingQA) ? botConfig.trainingQA : [];
  for (const qa of trainingQA) {
    if (qa.question && cleanMessage.toLowerCase().includes(qa.question.toLowerCase())) {
      return {
        reply: qa.answer,
        matchedIntent: 'TRAINED_QA_MATCH',
        suggestedFollowUps: ['Schedule Call', 'Share Proposal PDF'],
        sources: ['workspace_bot_training'],
      };
    }
  }

  // 2. Check custom objection handlers
  const objections = Array.isArray(botConfig?.objectionHandlers) ? botConfig.objectionHandlers : [];
  for (const obj of objections) {
    if (obj.trigger && new RegExp(obj.trigger, 'i').test(cleanMessage)) {
      return {
        reply: obj.counter,
        matchedIntent: 'OBJECTION_OVERCOME',
        suggestedFollowUps: ['Send Case Study', 'Lock in 10-Min Demo'],
        sources: ['bot_config_objections'],
      };
    }
  }

  // 3. Consultative Closer Rules
  if (/price|pricing|cost|charge|kitna|rate|fee/i.test(cleanMessage)) {
    return {
      reply: `Hi ${customerName}, our transparent enterprise plans start at ₹25,000/year, which includes unlimited SIM call recording vault, omnichannel WhatsApp messaging, and full closer team tracking. Would you like me to share the pricing PDF breakdown?`,
      matchedIntent: 'PRICING_INQUIRY',
      suggestedFollowUps: ['Download Pricing PDF', 'Speak with Closer'],
      sources: ['domain_consultative_engine'],
    };
  }

  if (/call|demo|schedule|book|meet|zoom/i.test(cleanMessage)) {
    return {
      reply: `Sounds great ${customerName}! I would be happy to set up a quick 10-minute walkthrough. Would 4 PM today or 11 AM tomorrow work best for a direct call or Google Meet?`,
      matchedIntent: 'DEMO_REQUEST',
      suggestedFollowUps: ['4 PM Today', '11 AM Tomorrow'],
      sources: ['domain_consultative_engine'],
    };
  }

  if (/discount|offer|coupon|deal|kam/i.test(cleanMessage)) {
    return {
      reply: `Hi ${customerName}, we currently have an onboarding launch incentive where you receive an extra 2 closer seats completely free with annual signup. Let us connect on a brief 5-minute call to activate this for your workspace.`,
      matchedIntent: 'DISCOUNT_INQUIRY',
      suggestedFollowUps: ['Claim 2 Free Seats', 'View Annual Plans'],
      sources: ['domain_consultative_engine'],
    };
  }

  // Default Consultative Closer pitch
  return {
    reply: `Hi ${customerName}, thanks for reaching out! AI Closer centralizes all client communications and SIM call logs into one verified dashboard with zero extra apps for your clients. Would you like a quick 5-minute walkthrough today?`,
    matchedIntent: 'GENERAL_INQUIRY',
    suggestedFollowUps: ['Book 10-Min Demo', 'View Feature Breakdown'],
    sources: ['domain_consultative_engine'],
  };
}

// Main Orchestrator: Generate AI Closer Reply across provider fallback chain
export async function generateAiCloserReply(params: {
  tenantId: string;
  customerPhone?: string;
  customerName?: string;
  messageText: string;
  systemContext?: string;
}): Promise<AiGenerationResult> {
  const { tenantId, messageText, customerName = 'there', systemContext } = params;
  const startTime = Date.now();

  // Load workspace AI settings & bot config
  const workspace = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (workspace?.settings as Record<string, any>) || {};
  const botConfig = settings.aiBotConfig || {};
  const customProviders = Array.isArray(settings.aiProviders) ? settings.aiProviders : DEFAULT_AI_PROVIDERS;

  // Sort providers by priority
  const providerChain = [...customProviders]
    .filter((p) => p.enabled !== false)
    .sort((a, b) => (a.priority || 99) - (b.priority || 99));

  // If no providers enabled, fallback to deterministic
  if (providerChain.length === 0) {
    providerChain.push(DEFAULT_AI_PROVIDERS.find((p) => p.id === 'fallback')!);
  }

  const systemPrompt =
    systemContext ||
    botConfig.personaPrompt ||
    `You are an elite B2B consultative sales closer for AI Closer CRM. Your tone is professional, consultative, and focused on securing a 10-minute demo. Reply concisely in 2-3 sentences. Never make false promises.`;

  let lastError: Error | null = null;

  for (const provider of providerChain) {
    const pStart = Date.now();
    try {
      if (provider.id === 'groq') {
        const apiKey = provider.apiKey || process.env.GROQ_API_KEY;
        if (!apiKey) continue;
        const text = await callGroq(apiKey, provider.model, systemPrompt, messageText, provider.timeoutMs || 4000);
        return {
          reply: text,
          provider: 'groq',
          model: provider.model,
          confidence: 0.95,
          tokensUsed: 120,
          latencyMs: Date.now() - pStart,
          suggestedFollowUps: ['Schedule Call', 'Share Proposal PDF'],
          matchedIntent: 'AI_AGENT_GENERATED',
          sources: ['groq_llama'],
        };
      }

      if (provider.id === 'gemini') {
        const apiKey = provider.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!apiKey) continue;
        const text = await callGemini(apiKey, provider.model, systemPrompt, messageText, provider.timeoutMs || 4000);
        return {
          reply: text,
          provider: 'gemini',
          model: provider.model,
          confidence: 0.94,
          tokensUsed: 110,
          latencyMs: Date.now() - pStart,
          suggestedFollowUps: ['Schedule Call', 'Share Proposal PDF'],
          matchedIntent: 'AI_AGENT_GENERATED',
          sources: ['google_gemini'],
        };
      }

      if (provider.id === 'openai') {
        const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
        if (!apiKey) continue;
        const text = await callOpenAI(apiKey, provider.model, systemPrompt, messageText, provider.timeoutMs || 4000);
        return {
          reply: text,
          provider: 'openai',
          model: provider.model,
          confidence: 0.95,
          tokensUsed: 115,
          latencyMs: Date.now() - pStart,
          suggestedFollowUps: ['Schedule Call', 'Share Proposal PDF'],
          matchedIntent: 'AI_AGENT_GENERATED',
          sources: ['openai_gpt'],
        };
      }

      if (provider.id === 'fallback') {
        const fallback = executeDeterministicFallback(messageText, customerName, botConfig);
        return {
          reply: fallback.reply,
          provider: 'fallback',
          model: 'aicloser-consultative-v1',
          confidence: 0.92,
          tokensUsed: 60,
          latencyMs: Date.now() - pStart,
          suggestedFollowUps: fallback.suggestedFollowUps,
          matchedIntent: fallback.matchedIntent,
          sources: fallback.sources,
        };
      }
    } catch (err: any) {
      lastError = err;
      logger.warn(`AI provider ${provider.id} failed, attempting next provider in fallback chain`, {
        error: String(err?.message || err),
        tenantId,
      });
    }
  }

  // Safety net: if all external providers in the chain threw or were skipped
  const fallback = executeDeterministicFallback(messageText, customerName, botConfig);
  return {
    reply: fallback.reply,
    provider: 'fallback_safety_net',
    model: 'aicloser-consultative-v1',
    confidence: 0.9,
    tokensUsed: 50,
    latencyMs: Date.now() - startTime,
    suggestedFollowUps: fallback.suggestedFollowUps,
    matchedIntent: fallback.matchedIntent,
    sources: fallback.sources,
  };
}

// Test a specific provider directly
export async function testAiProvider(params: {
  providerId: string;
  apiKey?: string;
  model?: string;
  prompt?: string;
}): Promise<{ success: boolean; latencyMs: number; reply: string; error: string | null }> {
  const { providerId, apiKey, model, prompt = 'Hello, can you help me schedule a demo for AI Closer CRM?' } = params;
  const pStart = Date.now();
  const sys = 'You are a helpful sales assistant. Reply in one sentence.';

  try {
    let reply = '';
    if (providerId === 'groq') {
      const key = apiKey || process.env.GROQ_API_KEY;
      if (!key) throw new Error('Missing Groq API key');
      reply = await callGroq(key, model || 'llama-3.3-70b-versatile', sys, prompt, 6000);
    } else if (providerId === 'gemini') {
      const key = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if (!key) throw new Error('Missing Gemini API key');
      reply = await callGemini(key, model || 'gemini-1.5-flash', sys, prompt, 6000);
    } else if (providerId === 'openai') {
      const key = apiKey || process.env.OPENAI_API_KEY;
      if (!key) throw new Error('Missing OpenAI API key');
      reply = await callOpenAI(key, model || 'gpt-4o-mini', sys, prompt, 6000);
    } else if (providerId === 'fallback') {
      const fb = executeDeterministicFallback(prompt, 'Friend', {});
      reply = fb.reply;
    } else {
      throw new Error(`Unknown provider ID ${providerId}`);
    }

    return {
      success: true,
      latencyMs: Date.now() - pStart,
      reply,
      error: null,
    };
  } catch (err: any) {
    return {
      success: false,
      latencyMs: Date.now() - pStart,
      reply: '',
      error: String(err?.message || err),
    };
  }
}
