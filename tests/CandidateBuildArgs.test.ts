import { parseCandidateBuildArgs } from '../src/handlers/users/apps/appdata/AppDataHandler'

test('candidate build args preserve confirmed strings and omit ambient environment', () => {
    expect(parseCandidateBuildArgs(undefined)).toEqual([])
    expect(
        parseCandidateBuildArgs(
            '{"PUBLIC_ENDPOINT":"https://api.test/","OPTIONAL_LABEL":""}'
        )
    ).toEqual([
        { key: 'PUBLIC_ENDPOINT', value: 'https://api.test/' },
        { key: 'OPTIONAL_LABEL', value: '' },
    ])
    for (const raw of [
        '[]',
        '{"BAD-ARG":"v"}',
        '{"ARG":1}',
        '{"ARG":"\\u0000"}',
    ]) {
        expect(() => parseCandidateBuildArgs(raw)).toThrow(
            'Candidate build arguments are malformed'
        )
    }
})
