import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

export function jsonError(status: number, error: string, detail?: unknown) {
  return NextResponse.json({ error, detail }, { status });
}

export function fromZod(e: ZodError) {
  return jsonError(400, 'invalid_input', e.flatten());
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}
