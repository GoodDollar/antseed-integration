export interface Env {
  USER_DATA: KVNamespace;
  STORAGE: R2Bucket;
  VAULT_ADDRESS: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle credit scoring requests
    if (path.startsWith('/credit-score')) {
      const userId = url.searchParams.get('user');
      if (!userId) {
        return new Response('Missing user parameter', { status: 400 });
      }

      try {
        // Get user data from KV
        const userData = await env.USER_DATA.get(`user:${userId}`);
        if (!userData) {
          return new Response(JSON.stringify({ score: 0, status: 'NO_DATA' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const data = JSON.parse(userData);
        
        // Simple scoring algorithm based on collateral and history
        let score = 500; // Base score
        
        if (data.collateralUsd > 1000) score += 200;
        else if (data.collateralUsd > 100) score += 100;
        
        if (data.onTimeRepaymentRate > 0.95) score += 150;
        else if (data.onTimeRepaymentRate > 0.8) score += 100;
        
        if (data.creditAgeMonths > 12) score += 100;
        
        // Ensure score is capped
        score = Math.min(score, 850);
        
        return new Response(JSON.stringify({ 
          score, 
          status: 'ACTIVE',
          lastUpdated: data.lastUpdated 
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Handle user data storage
    if (request.method === 'POST' && path === '/user-data') {
      const data = await request.json();
      const userId = data.userId;
      
      if (!userId) {
        return new Response('Missing userId', { status: 400 });
      }

      // Store user data in KV with TTL
      await env.USER_DATA.put(`user:${userId}`, JSON.stringify({
        ...data,
        lastUpdated: new Date().toISOString()
      }), {
        expirationTtl: 60 * 60 * 24 * 30 // 30 days
      });

      return new Response('User data stored successfully');
    }

    // Health check
    if (path === '/health') {
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};