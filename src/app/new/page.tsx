import { Header } from '@/app/components/Header';
import { MemoryForm } from '@/app/components/MemoryForm';
import { createMemoryAction } from './actions';

export const dynamic = 'force-dynamic';

export default function NewMemoryPage() {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6">
        <h1 className="text-xl font-semibold mb-4">새 메모리</h1>
        <MemoryForm action={createMemoryAction} submitLabel="Create" />
      </main>
    </div>
  );
}
