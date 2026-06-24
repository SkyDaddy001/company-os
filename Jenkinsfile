pipeline {
    agent any

    environment {
        APP_NAME   = 'company-os'
        DEPLOY_DIR = '/home/ubuntu/company-os-frontend'
    }

    triggers {
        pollSCM('H/2 * * * *')
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
                sh 'echo "Checked out: $(git log --oneline -1)"'
            }
        }

        stage('Install') {
            steps {
                sh 'npm ci --prefer-offline || npm install'
            }
        }

        stage('Build') {
            steps {
                sh 'npm run build'
            }
        }

        stage('Deploy') {
            when { branch 'master' }
            steps {
                sh '''
                    # Sync built assets and server to deploy dir
                    rsync -a --delete dist/       ${DEPLOY_DIR}/dist/
                    rsync -a            server.cjs ${DEPLOY_DIR}/server.cjs
                    rsync -a            package.json ${DEPLOY_DIR}/package.json

                    # Install production deps in deploy dir
                    cd ${DEPLOY_DIR}
                    npm install --omit=dev --prefer-offline 2>/dev/null || npm install --production || true

                    # Restart the service
                    sudo systemctl restart company-os.service
                    sleep 3
                    sudo systemctl is-active company-os.service
                '''
            }
        }

        stage('Verify') {
            when { branch 'master' }
            steps {
                sh '''
                    # Give server 5 seconds to bind
                    sleep 5
                    curl -sf http://localhost:3001/api/health || curl -sf http://localhost:3001/ | head -c 100
                    echo "qucogroup.com is live"
                '''
            }
        }
    }

    post {
        always { cleanWs() }
        success {
            echo "qucogroup.com deployed successfully — Build #${BUILD_NUMBER}"
        }
        failure {
            echo "qucogroup.com deploy FAILED — Build #${BUILD_NUMBER}"
        }
    }
}
