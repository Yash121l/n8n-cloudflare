import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: Record<string, unknown>;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** Arguments for a tool call: '6*7' for every property of the tool's JSON schema. */
function toolArguments(schema: unknown): Json {
	const properties =
		isRecord(schema) && isRecord(schema.properties) ? Object.keys(schema.properties) : ['input'];
	return Object.fromEntries(properties.map((name) => [name, '6*7']));
}

const vector = (text: string) => {
	const v = new Array<number>(8).fill(0);
	for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) / 100;
	return v;
};

/**
 * OpenAI chat: calls the first tool once, then answers with the tool result.
 * Without tools it answers in JSON when the prompt asks for JSON.
 */
function openAiChat(payload: Json): Json {
	const messages = records(payload.messages);
	const last = messages.at(-1);
	const tools = records(payload.tools);
	let message: Json;
	if (last?.role === 'tool') {
		message = { role: 'assistant', content: `The answer is ${String(last.content).trim()}.` };
	} else if (tools.length > 0) {
		const fn = isRecord(tools[0].function) ? tools[0].function : {};
		message = {
			role: 'assistant',
			content: null,
			tool_calls: [
				{
					id: 'call_1',
					type: 'function',
					function: {
						name: String(fn.name),
						arguments: JSON.stringify(toolArguments(fn.parameters)),
					},
				},
			],
		};
	} else if (JSON.stringify(messages).includes('JSON')) {
		message = { role: 'assistant', content: '```json\n{"output":{"answer":"hi"}}\n```' };
	} else {
		message = { role: 'assistant', content: 'plain reply' };
	}
	return {
		id: 'chatcmpl-1',
		object: 'chat.completion',
		created: 1,
		model: payload.model,
		choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	};
}

/** Server-sent events of an OpenAI chat reply, one delta for each word of the content. */
function openAiChatEvents(reply: Json): Json[] {
	const choice = records(reply.choices)[0];
	const message = isRecord(choice?.message) ? choice.message : {};
	const base = { id: reply.id, object: 'chat.completion.chunk', created: 1, model: reply.model };
	const delta = (value: Json, finishReason: string | null = null) => ({
		...base,
		choices: [{ index: 0, delta: value, finish_reason: finishReason }],
	});
	const events: Json[] = [delta({ role: 'assistant', content: '' })];
	if (typeof message.content === 'string') {
		for (const word of message.content.match(/\S+\s*/g) ?? [])
			events.push(delta({ content: word }));
	}
	for (const [index, call] of records(message.tool_calls).entries())
		events.push(delta({ tool_calls: [{ index, ...call }] }));
	events.push(delta({}, String(choice?.finish_reason ?? 'stop')));
	return events;
}

/** Anthropic messages: same script as `openAiChat`. */
function anthropicMessages(payload: Json): Json {
	const last = records(payload.messages).at(-1);
	const result = records(last?.content).find((block) => block.type === 'tool_result');
	const tools = records(payload.tools);
	let content: Json[];
	let stopReason = 'end_turn';
	if (result) {
		content = [{ type: 'text', text: `Anthropic says: ${JSON.stringify(result.content)}` }];
	} else if (tools.length > 0) {
		content = [
			{
				type: 'tool_use',
				id: 'toolu_1',
				name: tools[0].name,
				input: toolArguments(tools[0].input_schema),
			},
		];
		stopReason = 'tool_use';
	} else {
		content = [{ type: 'text', text: 'plain anthropic reply' }];
	}
	return {
		id: 'msg_1',
		type: 'message',
		role: 'assistant',
		model: payload.model,
		content,
		stop_reason: stopReason,
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 5 },
	};
}

function embeddings(payload: Json): Json {
	const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
	return {
		object: 'list',
		model: payload.model,
		data: inputs.map((text, index) => ({
			object: 'embedding',
			index,
			embedding: vector(String(text)),
		})),
		usage: { prompt_tokens: 1, total_tokens: 1 },
	};
}

/** A scripted OpenAI- and Anthropic-compatible server on a free local port. OpenAI chat also streams. */
export async function startFakeLlm() {
	const requests: RecordedRequest[] = [];
	const server = createServer(async (req, res) => {
		let text = '';
		for await (const chunk of req) text += String(chunk);
		const parsed: unknown = text ? JSON.parse(text) : {};
		const body = isRecord(parsed) ? parsed : {};
		const path = req.url ?? '/';
		requests.push({ path, headers: req.headers, body });

		if (path.endsWith('/chat/completions') && body.stream === true) {
			// A model name like `gpt-slow-300` waits 300 ms before each event.
			const delay = Number(/-slow-(\d+)$/.exec(String(body.model))?.[1] ?? 0);
			res.statusCode = 200;
			res.setHeader('content-type', 'text/event-stream');
			for (const event of openAiChatEvents(openAiChat(body))) {
				if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
				res.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			res.end('data: [DONE]\n\n');
			return;
		}
		let reply: Json | undefined;
		if (path.endsWith('/chat/completions')) reply = openAiChat(body);
		else if (path.endsWith('/messages')) reply = anthropicMessages(body);
		else if (path.endsWith('/embeddings')) reply = embeddings(body);
		else if (path.endsWith('/models'))
			reply = { object: 'list', data: [{ id: 'fake-1', object: 'model' }] };
		res.statusCode = reply ? 200 : 404;
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(reply ?? { error: `no fake for ${path}` }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		requests,
		close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
