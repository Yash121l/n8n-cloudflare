import { nanoid } from 'nanoid';

/** 16-character ids as n8n generates them for workflows, credentials, projects and tags. */
export const newId = () => nanoid(16);

export const newUuid = () => crypto.randomUUID();
