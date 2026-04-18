import type { FastifyInstance } from 'fastify';

interface DiffChunk {
  type: 'equal' | 'added' | 'removed';
  value: string;
}

function computeDiff(a: string, b: string, mode: 'line' | 'word'): DiffChunk[] {
  const tokensA = mode === 'line' ? a.split('\n') : a.split(/(\s+)/);
  const tokensB = mode === 'line' ? b.split('\n') : b.split(/(\s+)/);

  // Simple LCS-based diff
  const m = tokensA.length;
  const n = tokensB.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (tokensA[i - 1] === tokensB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffChunk[] = [];
  let i = m;
  let j = n;
  const sep = mode === 'line' ? '\n' : '';

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && tokensA[i - 1] === tokensB[j - 1]) {
      result.unshift({ type: 'equal', value: tokensA[i - 1] + sep });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'added', value: tokensB[j - 1] + sep });
      j--;
    } else {
      result.unshift({ type: 'removed', value: tokensA[i - 1] + sep });
      i--;
    }
  }

  return result;
}

export function comparerRoutes(fastify: FastifyInstance): void {
  fastify.post('/api/comparer/diff', async (req, reply) => {
    const { a, b, mode } = req.body as {
      a: string;
      b: string;
      mode?: 'line' | 'word';
    };

    const diff = computeDiff(a, b, mode || 'line');
    return reply.send({ diff });
  });
}
