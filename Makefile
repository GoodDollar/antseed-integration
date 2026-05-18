.PHONY: test contracts backend

test: contracts backend

contracts:
	cd contracts && forge test -vv

backend:
	cd backend && npm ci && npm run build && npm test
