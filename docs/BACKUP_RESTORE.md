# Backup and restore

`npm run backup` 또는 `POST /admin/backup`은 better-sqlite3 온라인 백업 API를 사용합니다. 파일은 `data/backups`에 생성되고 생성 UTC 시각, 스키마 버전, integrity 상태가 백업 DB와 운영 DB의 `backup_history`에 기록됩니다. WAL/SHM 파일을 직접 복사하지 마십시오.

## 저장소 권한

POSIX에서는 백업 임시 파일을 `0o600`으로 생성하며, 회귀 테스트가 게시된 inode의 group/other 권한 비트가 0인지 확인합니다. 따라서 이 저장소의 "owner-only" 보장은 POSIX에만 적용됩니다.

Windows의 Node.js file mode는 NTFS ACL을 설정하지 않습니다. Windows 배포 담당자는 운영 전에 다음 위치의 보호된 NTFS ACL을 Gateway 서비스 계정으로 제한하고 실제 유효 접근 권한을 검증해야 합니다.

- 설정된 `DATABASE_PATH`가 있는 data 디렉터리
- `data/backups`와 별도 backup 보관 위치
- 복원 검증에 사용하는 staging 위치

이는 배포 환경의 책임이며, 적용하지 않으면 같은 host의 다른 계정이 공급자 자격증명과 token hash를 포함한 DB 또는 backup을 읽을 수 있습니다. 서비스 계정, 상속 정책, 운영 복구 계정이 배포마다 다르므로 이 문서는 일률적인 ACL 초기화·교체 명령을 제공하지 않습니다. 조직의 배포 도구로 최소 권한 ACL을 적용하고 검증하십시오.

백업을 운영 중인 DB에 바로 덮어쓰거나 운영 DB 자체를 검증 대상으로 사용하지 마십시오. 백업 파일을 별도 경로에 복사한 독립적인 복구 복사본만 검증합니다.

```powershell
npm.cmd run verify-backup -- C:\restore-staging\gateway-restore-copy.db
```

복구 절차:

1. Gateway를 중지합니다.
2. 현재 DB 파일과 WAL/SHM 파일을 별도 격리 위치로 이동합니다.
3. 선택한 백업을 별도 경로에 복사하고 위 명령으로 integrity, 외래 키, 현재 스키마 버전을 검증합니다.
4. 검증된 독립 복사본을 설정된 `DATABASE_PATH`로 복사합니다.
5. Gateway를 시작하고 `npm run doctor`를 실행합니다.

복구는 의도적으로 자동 API로 제공하지 않습니다. 실행 중 DB를 덮어써 데이터 손실을 일으키는 경로를 만들지 않기 위해서입니다.
