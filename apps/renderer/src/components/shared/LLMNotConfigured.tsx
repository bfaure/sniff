import { useNavigate } from '../../App';

export function LLMNotConfigured({ inline = false }: { inline?: boolean }) {
  const navigate = useNavigate();
  const base = inline
    ? 'text-xs rounded border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-amber-200'
    : 'rounded border border-amber-700/60 bg-amber-950/30 p-4 text-amber-100';
  return (
    <div className={base}>
      <div className="font-medium mb-1">AWS Bedrock is not configured</div>
      <div className="opacity-80 mb-2">
        AI features need AWS credentials with Bedrock access. Add them in Settings → AI to enable chat,
        analysis, and guided tests.
      </div>
      <button
        onClick={() => navigate('settings')}
        className="rounded bg-amber-600 hover:bg-amber-500 text-white text-xs px-3 py-1"
      >
        Open Settings
      </button>
    </div>
  );
}

export function isLLMNotConfigured(error: string | null | undefined, code?: string | null): boolean {
  if (code === 'LLM_NOT_CONFIGURED') return true;
  if (!error) return false;
  return /not configured|LLM_NOT_CONFIGURED|Bedrock credentials/i.test(error);
}
